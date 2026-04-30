import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { DaemonContext } from './server.js';
import type { PreToolUsePayload, NotificationPayload, Decision } from '../core/types.js';
import { saveMode, type Mode } from './state.js';
import { computeAllowMatcher, addProjectAllow } from './allowlist.js';
import { loadAllowlist, matchAny } from './allowlistMatch.js';
import { appendAudit } from './audit.js';
import {
  formatPermissionPrompt,
  formatNotification,
  formatQAPrompt,
  type PromptFormatContext,
} from './promptFormat.js';
import { isQAPrompt, isProgressMarker } from './notificationDetect.js';
import { injectViaPty } from '../inject/pty.js';
import type { SessionSnap } from './sleeping.js';
import { topicContextFromHook } from './topicContext.js';
import type { ChannelContext } from '../channels/Channel.js';
import { SYSTEM_TOPIC_KEY } from '../channels/telegram/topics.js';

export function registerRoutes(app: Express, ctx: DaemonContext): void {
  const fmtCtx = (): PromptFormatContext => ({
    hostname: ctx.hostname,
    sleeping: ctx.state.sleeping.snapshot(),
  });
  const hookTopicCtx = (p: { cwd?: string; session_id: string }): ChannelContext =>
    topicContextFromHook(p, {
      injectClients: ctx.injectClients,
      sleepingSnap: ctx.state.sleeping.snapshot(),
    });

  app.get('/v1/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
    });
  });

  app.get('/v1/status', (_req, res) => {
    const now = Date.now();
    const response: Record<string, unknown> = {
      daemon: {
        pid: process.pid,
        uptimeSec: Math.floor((now - ctx.startedAt) / 1000),
        startedAt: new Date(ctx.startedAt).toISOString(),
        hostname: ctx.hostname,
        port: ctx.config.daemon.port,
      },
      pending: {
        permissions: ctx.pending.size(),
        notifications: ctx.pendingNotifications.size(),
        replies: ctx.pendingReplies.size(),
      },
      mode: ctx.state.mode,
      gaming: ctx.state.gaming.snapshot(),
      sleeping: ctx.state.sleeping.snapshot(),
      injectClients: ctx.injectClients.list(),
    };
    if (ctx.config.channel.type === 'telegram') {
      const stats = ctx.channel.topicStats?.();
      response.topics = stats ?? { forumMode: ctx.config.channel.forumMode, count: 0 };
    }
    res.json(response);
  });

  app.get('/v1/mode', (_req, res) => {
    res.json({ mode: ctx.state.mode });
  });

  app.get('/v1/gaming', (_req, res) => {
    res.json(ctx.state.gaming.snapshot());
  });

  app.put('/v1/gaming', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { on?: unknown; durationMs?: unknown };
    if (typeof body.on !== 'boolean') {
      res.status(400).json({ error: "body must be { on: true, durationMs?: number } | { on: false }" });
      return;
    }
    if (body.on === false) {
      ctx.state.gaming.cancel();
    } else {
      const durationMs = body.durationMs;
      if (durationMs !== undefined && (typeof durationMs !== 'number' || durationMs <= 0)) {
        res.status(400).json({ error: 'durationMs must be a positive number when provided' });
        return;
      }
      try {
        ctx.state.gaming.arm(durationMs as number | undefined);
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
        return;
      }
    }
    const snap = ctx.state.gaming.snapshot();
    ctx.logger.info('gaming toggled', snap as unknown as Record<string, unknown>);
    res.json({ ok: true, active: snap.active, until: snap.until });
  });

  app.get('/v1/sleeping', (_req, res) => {
    res.json(ctx.state.sleeping.snapshot());
  });

  app.post('/v1/sleeping', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      repo?: string;
      prompt?: string;
      plan?: string;
      maxDurationMs?: number;
      model?: string;
    };
    if (typeof body.repo !== 'string' || !body.repo) {
      res.status(400).json({ error: 'repo required' });
      return;
    }
    if (!body.prompt && !body.plan) {
      res.status(400).json({ error: 'prompt or plan required' });
      return;
    }
    if (body.prompt && body.plan) {
      res.status(400).json({ error: 'prompt and plan are mutually exclusive' });
      return;
    }
    if (body.model !== undefined && body.model !== 'sonnet' && body.model !== 'opus') {
      res.status(400).json({ error: "model must be 'sonnet' or 'opus'" });
      return;
    }
    const maxDurationMs = body.maxDurationMs ?? ctx.config.policy.sleepMaxDurationMs;
    const workRoot = expandHome(ctx.config.policy.sleepWorktreeDir);
    try {
      await fsp.mkdir(workRoot, { recursive: true });
      const session = await ctx.state.sleeping.start({
        repo: body.repo,
        workRoot,
        maxDurationMs,
        prompt: body.prompt,
        plan: body.plan,
        model: body.model as 'sonnet' | 'opus' | undefined,
      });
      res.status(202).json({
        ok: true,
        slug: session.slug,
        branch: session.branch,
        worktreePath: session.worktreePath,
        startedAt: session.startedAt,
        expectedEndAt: session.expectedEndAt,
      });
    } catch (e) {
      const err = e as Error & { capacity?: number; active?: SessionSnap[] };
      if (err.name === 'CapacityReachedError') {
        res.status(429).json({
          error: 'capacity reached',
          capacity: err.capacity,
          active: err.active,
        });
        return;
      }
      const msg = err.message;
      if (msg.includes('already')) {
        res.status(409).json({ error: msg });
      } else {
        res.status(400).json({ error: msg });
      }
    }
  });

  app.post('/v1/sleeping/cancel', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { slug?: unknown; all?: unknown };
    const opts: { slug?: string; all?: boolean } = {};
    if (typeof body.slug === 'string' && body.slug) opts.slug = body.slug;
    if (body.all === true) opts.all = true;
    try {
      const result = await ctx.state.sleeping.cancel(opts);
      res.json({ ok: true, cancelled: result.cancelled });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete('/v1/sleeping', async (_req, res) => {
    // Legacy: equivalent to POST /v1/sleeping/cancel with no args (cancel the
    // single active session, throws if multiple active).
    try {
      const result = await ctx.state.sleeping.cancel();
      res.json({
        ok: true,
        cancelled: result.cancelled.length > 0,
        slugs: result.cancelled,
        reason: result.cancelled.length > 0 ? 'cancelled' : 'idle',
      });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.put('/v1/mode', (req: Request, res: Response) => {
    const mode = (req.body ?? {}).mode;
    if (mode !== 'here' && mode !== 'away') {
      res.status(400).json({ error: "mode must be 'here' or 'away'" });
      return;
    }
    ctx.state.mode = mode as Mode;
    saveMode(mode as Mode).catch((e) => {
      ctx.logger.warn('saveMode failed', { err: (e as Error).message });
    });
    res.json({ ok: true, mode: ctx.state.mode });
  });

  app.post('/v1/topics/clear', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { slug?: unknown; all?: unknown; dryRun?: unknown };
    if (!ctx.channel.clearTopics) {
      res.status(400).json({ error: 'channel does not support forum topics' });
      return;
    }
    const opts: { keys?: string[]; all?: boolean; except?: string[]; dryRun?: boolean } = {};
    if (typeof body.slug === 'string' && body.slug) {
      opts.keys = [body.slug];
    } else if (body.all === true) {
      opts.all = true;
      opts.except = [SYSTEM_TOPIC_KEY];
    } else {
      res.status(400).json({ error: 'either slug (string) or all (true) required' });
      return;
    }
    if (body.dryRun === true) opts.dryRun = true;
    try {
      const result = await ctx.channel.clearTopics(opts);
      res.json({ ok: true, ...result, dryRun: opts.dryRun === true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/v1/chat/clear', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { last?: unknown; dryRun?: unknown };
    if (!ctx.channel.clearLastMessages) {
      res.status(400).json({ error: 'channel does not support message deletion' });
      return;
    }
    if (typeof body.last !== 'number' || !Number.isInteger(body.last) || body.last <= 0) {
      res.status(400).json({ error: 'last must be a positive integer' });
      return;
    }
    try {
      const result = await ctx.channel.clearLastMessages(body.last, {
        dryRun: body.dryRun === true,
      });
      res.json({ ok: true, ...result, dryRun: body.dryRun === true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/v1/heartbeat', (req: Request, res: Response) => {
    const cancelled = ctx.pendingNotifications.cancelAll();
    const source = ((req.body ?? {}).source ?? 'unknown') as string;
    if (cancelled > 0) {
      ctx.logger.info('heartbeat cancelled pending', { cancelled, source });
    } else {
      ctx.logger.debug('heartbeat (no-op)', { source });
    }
    res.json({ ok: true, cancelled });
  });

  app.post('/v1/inject-clients', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { slug?: unknown; pid?: unknown; cwd?: unknown; localPort?: unknown };
    if (typeof body.slug !== 'string' || !body.slug) {
      res.status(400).json({ error: 'slug required' });
      return;
    }
    if (typeof body.pid !== 'number' || !Number.isFinite(body.pid)) {
      res.status(400).json({ error: 'pid must be a number' });
      return;
    }
    if (typeof body.cwd !== 'string' || !body.cwd) {
      res.status(400).json({ error: 'cwd required' });
      return;
    }
    if (typeof body.localPort !== 'number' || !Number.isFinite(body.localPort)) {
      res.status(400).json({ error: 'localPort must be a number' });
      return;
    }
    try {
      ctx.injectClients.register({
        slug: body.slug,
        pid: body.pid,
        cwd: body.cwd,
        localPort: body.localPort,
        registeredAt: Date.now(),
      });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
      return;
    }
    appendAudit({
      ts: new Date().toISOString(),
      requestId: body.slug,
      tool: 'inject',
      cwd: body.cwd,
      decision: 'ask',
      reason: null,
      source: 'client-registered',
      remember: false,
    }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
    res.json({ ok: true, slug: body.slug });
  });

  app.delete('/v1/inject-clients/:slug', (req: Request, res: Response) => {
    const slug = req.params.slug;
    const had = ctx.injectClients.deregister(slug);
    if (had) {
      appendAudit({
        ts: new Date().toISOString(),
        requestId: slug,
        tool: 'inject',
        cwd: null,
        decision: 'ask',
        reason: null,
        source: 'client-deregistered',
        remember: false,
      }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
    }
    res.json({ ok: true, removed: had });
  });

  app.get('/v1/inject-clients', (_req: Request, res: Response) => {
    res.json(ctx.injectClients.list());
  });

  app.post('/v1/notify', (req: Request, res: Response) => {
    const payload = req.body as NotificationPayload;
    if (payload.session_id && payload.cwd) {
      ctx.injectClients.bindSessionByCwd(payload.session_id, payload.cwd);
    }
    const topicCtx = hookTopicCtx(payload);
    // J1: gaming or sleep silences the Notification hook stream. Q&A prompts
    // (matched on message text, not handler routing — so stuck-claude inside
    // a sleep worktree still surfaces via the regular notif fallback) and
    // explicit `[[KUROBOTO]]` progress markers bypass.
    const gamingActive = ctx.state.gaming.snapshot().active;
    const sleepActive = ctx.state.sleeping.snapshot().active.length > 0;
    if (
      (gamingActive || sleepActive) &&
      !isQAPrompt(payload.message) &&
      !isProgressMarker(payload.message)
    ) {
      ctx.logger.info('notify suppressed (gaming/sleep, non-Q&A)', {
        cwd: payload.cwd,
        gaming: gamingActive,
        sleep: sleepActive,
      });
      res.json({ ok: true, suppressed: true });
      return;
    }
    if (shouldHandleAsQA(payload, ctx)) {
      // Fire-and-forget: the Q&A flow runs end-to-end (send question, await
      // reply, inject, audit) in the background. The hook just gets ack.
      handleQAPrompt(payload, ctx, fmtCtx(), topicCtx).catch((e) =>
        ctx.logger.warn('Q&A flow failed', { err: (e as Error).message }),
      );
      ctx.logger.info('notify received (Q&A)', { cwd: payload.cwd });
      res.json({ ok: true, qa: true });
      return;
    }
    const delayMs = ctx.state.mode === 'away' ? 0 : ctx.config.policy.notifyDelayMs;
    ctx.logger.info('notify received', {
      mode: ctx.state.mode,
      delayMs,
      cwd: payload.cwd,
      hasMessage: typeof payload.message === 'string',
    });
    if (delayMs <= 0) {
      formatNotification(payload, fmtCtx())
        .then((text) => ctx.channel.sendNotification(text, topicCtx))
        .then(() => ctx.logger.info('notify sent (immediate)'))
        .catch((e) => ctx.logger.warn('sendNotification failed', { err: (e as Error).message }));
    } else {
      ctx.pendingNotifications.arm(payload, delayMs, (p) => {
        ctx.logger.info('notify timer fired, sending');
        // Re-derive context at fire time since sleep / inject-client state
        // may have changed during the delay.
        const lateCtx = hookTopicCtx(p);
        formatNotification(p, fmtCtx())
          .then((text) => ctx.channel.sendNotification(text, lateCtx))
          .then(() => ctx.logger.info('notify sent (delayed)'))
          .catch((e) => ctx.logger.warn('sendNotification (delayed) failed', { err: (e as Error).message }));
      });
    }
    res.json({ ok: true, delayed: delayMs > 0, delayMs });
  });

  app.post('/v1/permission', async (req: Request, res: Response) => {
    const payload = req.body as PreToolUsePayload;
    if (payload.session_id && payload.cwd) {
      ctx.injectClients.bindSessionByCwd(payload.session_id, payload.cwd);
    }
    const gamingSnap = ctx.state.gaming.snapshot();
    const topicCtx = hookTopicCtx(payload);
    if (gamingSnap.active && !ctx.config.policy.gamingAlwaysAsk.includes(payload.tool_name)) {
      const decision: Decision = { decision: 'allow', reason: 'gaming' };
      appendAudit({
        ts: new Date().toISOString(),
        requestId: 'gaming',
        tool: payload.tool_name,
        cwd: payload.cwd ?? null,
        decision: 'allow',
        reason: 'gaming',
        source: 'gaming',
        remember: false,
      }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
      // No per-tool FYI on Telegram. Claude hammers tool calls (Read, Grep,
      // Bash, etc.) fast enough that per-call notifications flood the client
      // and crash it — observed in both sleep and active-use scenarios.
      // Audit log keeps the full record at ~/.config/kuroboto/audit.jsonl.
      res.json(decision);
      return;
    }
    const matchers = ctx.config.policy.permissionMatchers;
    const matched = matchers.includes(payload.tool_name);
    if (ctx.state.mode === 'here' || !matched) {
      const decision: Decision = { decision: 'ask' };
      res.json(decision);
      return;
    }

    // Allowlist match — read project's .claude/settings.local.json and short-circuit
    // if the tool call matches a deny or allow pattern. Deny wins over allow.
    // loadAllowlist swallows read/parse errors internally and returns empty arrays;
    // no outer try/catch needed.
    if (payload.cwd) {
      const allowlist = await loadAllowlist(payload.cwd);
      if (matchAny(payload.tool_name, payload.tool_input, allowlist.deny)) {
        const decision: Decision = { decision: 'deny', reason: 'allowlist' };
        appendAudit({
          ts: new Date().toISOString(),
          requestId: randomUUID(),
          tool: payload.tool_name,
          cwd: payload.cwd,
          decision: 'deny',
          reason: 'allowlist',
          source: 'allowlist-deny',
          remember: false,
        }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
        res.json(decision);
        return;
      }
      if (matchAny(payload.tool_name, payload.tool_input, allowlist.allow)) {
        const decision: Decision = { decision: 'allow', reason: 'allowlist' };
        appendAudit({
          ts: new Date().toISOString(),
          requestId: randomUUID(),
          tool: payload.tool_name,
          cwd: payload.cwd,
          decision: 'allow',
          reason: 'allowlist',
          source: 'allowlist-allow',
          remember: false,
        }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
        res.json(decision);
        return;
      }
    }

    const { requestId, promise } = ctx.pending.create(ctx.config.policy.permissionTimeoutMs);
    try {
      const text = await formatPermissionPrompt(payload, fmtCtx());
      await ctx.channel.sendPrompt(
        {
          requestId,
          text,
          buttons: [
            { label: '✅ Allow', action: 'allow' },
            { label: '🔓 Allow & remember', action: 'allow_remember' },
            { label: '❌ Deny', action: 'deny' },
            { label: '💬 Deny with note', action: 'deny_note' },
          ],
        },
        topicCtx,
      );
    } catch (e) {
      ctx.logger.error('sendPrompt failed', { err: (e as Error).message });
      ctx.pending.resolve(requestId, { decision: 'ask', reason: 'channel unavailable' });
    }
    const decision = await promise;
    if (decision.decision === 'allow' && decision.remember && payload.cwd) {
      const matcher = computeAllowMatcher(
        payload.tool_name,
        payload.tool_input,
        ctx.config.policy.rememberGranularity,
      );
      try {
        await addProjectAllow(payload.cwd, matcher);
        ctx.logger.info('persisted allow matcher', { matcher, cwd: payload.cwd });
      } catch (e) {
        ctx.logger.warn('failed to persist allow matcher', { err: (e as Error).message });
      }
    }
    // Audit log entry — best-effort, never blocks the hook response
    appendAudit({
      ts: new Date().toISOString(),
      requestId,
      tool: payload.tool_name,
      cwd: payload.cwd ?? null,
      decision: decision.decision,
      reason: decision.reason ?? null,
      source: deriveSource(decision),
      remember: decision.decision === 'allow' && !!decision.remember,
    }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
    const { remember: _r, ...stripped } = decision as { remember?: boolean } & Decision;
    res.json(stripped);
  });
}

function deriveSource(d: Decision): string {
  if (d.decision === 'deny' && d.reason === 'timeout') return 'timeout';
  if (d.decision === 'ask' && d.reason === 'channel unavailable') return 'channel-error';
  return 'telegram';
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function shouldHandleAsQA(payload: NotificationPayload, ctx: DaemonContext): boolean {
  if (!ctx.config.inject.enabled) return false;
  // tmux strategy needs the legacy InjectStrategy; pty strategy doesn't (the
  // inject step looks up a registered CLI by session_id at reply time).
  if (ctx.config.inject.strategy === 'tmux' && !ctx.inject) return false;
  if (!isQAPrompt(payload.message)) return false;
  // Sleep mode is autonomous: if Claude pauses inside a sleep worktree, it's
  // a stuck session — fall through to the regular notif path so the user can
  // investigate, rather than waiting indefinitely for a Q&A reply.
  if (payload.cwd) {
    const snap = ctx.state.sleeping.snapshot();
    const inSleep = snap.active.some((s) => samePath(payload.cwd!, s.worktreePath));
    if (inSleep) return false;
  }
  return true;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

async function handleQAPrompt(
  payload: NotificationPayload,
  ctx: DaemonContext,
  fmtCtx: PromptFormatContext,
  topicCtx: ChannelContext,
): Promise<void> {
  const text = await formatQAPrompt(payload, fmtCtx);
  let sentMessageId: string;
  try {
    ({ sentMessageId } = await ctx.channel.sendQuestion({ text, forceReply: true }, topicCtx));
  } catch (e) {
    ctx.logger.warn('Q&A sendQuestion failed', { err: (e as Error).message });
    return;
  }
  const { promise } = ctx.pendingReplies.create(sentMessageId, ctx.config.inject.replyTimeoutMs);
  void appendAudit({
    ts: new Date().toISOString(),
    requestId: sentMessageId,
    tool: 'Q&A',
    cwd: payload.cwd ?? null,
    decision: 'ask',
    reason: null,
    source: 'qa-pending',
    remember: false,
  }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));

  let reply: string;
  try {
    reply = await promise;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'timeout') {
      void appendAudit({
        ts: new Date().toISOString(),
        requestId: sentMessageId,
        tool: 'Q&A',
        cwd: payload.cwd ?? null,
        decision: 'deny',
        reason: 'timeout',
        source: 'qa-timeout',
        remember: false,
      }).catch((e2) => ctx.logger.warn('audit append failed', { err: (e2 as Error).message }));
      await ctx.channel
        .sendNotification('⏱ Q&A expirou (Claude pode ainda estar esperando)', topicCtx)
        .catch((e2) => ctx.logger.warn('sendNotification (qa-timeout) failed', { err: (e2 as Error).message }));
      return;
    }
    // shutdown / cancelled — silent drop
    return;
  }

  const result = await dispatchInject(payload, reply, ctx);
  if (result.ok) {
    void appendAudit({
      ts: new Date().toISOString(),
      requestId: sentMessageId,
      tool: 'Q&A',
      cwd: payload.cwd ?? null,
      decision: 'allow',
      reason: 'injected',
      source: 'qa-injected',
      remember: false,
    }).catch((e) => ctx.logger.warn('audit append failed', { err: (e as Error).message }));
    await ctx.channel
      .sendNotification('✅ Reply injetada', topicCtx)
      .catch((e) => ctx.logger.warn('sendNotification (qa-injected) failed', { err: (e as Error).message }));
    return;
  }
  void appendAudit({
    ts: new Date().toISOString(),
    requestId: sentMessageId,
    tool: 'Q&A',
    cwd: payload.cwd ?? null,
    decision: 'deny',
    reason: result.reason,
    source: 'qa-inject-failed',
    remember: false,
  }).catch((e2) => ctx.logger.warn('audit append failed', { err: (e2 as Error).message }));
  await ctx.channel
    .sendNotification(`❌ Inject falhou: ${result.reason}\n\nSua reply foi:\n${reply}`, topicCtx)
    .catch((e2) => ctx.logger.warn('sendNotification (qa-inject-failed) failed', { err: (e2 as Error).message }));
}

/**
 * Routes a Q&A reply to the right injection backend based on
 * `config.inject.strategy`. PTY: look up the registered CLI by session_id
 * (with a cwd-based late-bind fallback) and POST /inject. Tmux: call the
 * legacy strategy. Returns a normalised result either way; errors become
 * the user-facing fallback message.
 */
async function dispatchInject(
  payload: NotificationPayload,
  reply: string,
  ctx: DaemonContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (ctx.config.inject.strategy === 'tmux') {
    if (!ctx.inject) return { ok: false, reason: 'tmux strategy enabled but inject strategy not initialised' };
    try {
      await ctx.inject.inject(reply);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
  // PTY strategy
  let client = ctx.injectClients.lookupBySession(payload.session_id);
  if (!client && payload.cwd) {
    ctx.injectClients.bindSessionByCwd(payload.session_id, payload.cwd);
    client = ctx.injectClients.lookupBySession(payload.session_id);
  }
  if (!client) {
    return { ok: false, reason: 'no client registered for this session' };
  }
  try {
    await injectViaPty(client, reply, { authToken: ctx.config.daemon.authToken });
    return { ok: true };
  } catch (e) {
    // CLI is unreachable — drop the registration so future replies fall
    // through fast instead of timing out on a dead port.
    ctx.injectClients.deregister(client.slug);
    return { ok: false, reason: (e as Error).message };
  }
}
