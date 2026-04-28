import type { Express, Request, Response } from 'express';
import type { DaemonContext } from './server.js';
import type { PreToolUsePayload, NotificationPayload, Decision } from '../core/types.js';
import { saveMode, type Mode } from './state.js';
import { computeAllowMatcher, addProjectAllow } from './allowlist.js';
import { appendAudit } from './audit.js';

export function registerRoutes(app: Express, ctx: DaemonContext): void {
  app.get('/v1/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
      pending: ctx.pending.size(),
      pendingNotifications: ctx.pendingNotifications.size(),
      mode: ctx.state.mode,
      gaming: ctx.state.gaming.snapshot(),
    });
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

  app.post('/v1/notify', (req: Request, res: Response) => {
    const payload = req.body as NotificationPayload;
    const delayMs = ctx.state.mode === 'away' ? 0 : ctx.config.policy.notifyDelayMs;
    ctx.logger.info('notify received', {
      mode: ctx.state.mode,
      delayMs,
      cwd: payload.cwd,
      hasMessage: typeof payload.message === 'string',
    });
    if (delayMs <= 0) {
      ctx.channel.sendNotification(formatNotification(payload))
        .then(() => ctx.logger.info('notify sent (immediate)'))
        .catch((e) => ctx.logger.warn('sendNotification failed', { err: (e as Error).message }));
    } else {
      ctx.pendingNotifications.arm(payload, delayMs, (p) => {
        ctx.logger.info('notify timer fired, sending');
        ctx.channel.sendNotification(formatNotification(p))
          .then(() => ctx.logger.info('notify sent (delayed)'))
          .catch((e) => ctx.logger.warn('sendNotification (delayed) failed', { err: (e as Error).message }));
      });
    }
    res.json({ ok: true, delayed: delayMs > 0, delayMs });
  });

  app.post('/v1/permission', async (req: Request, res: Response) => {
    const payload = req.body as PreToolUsePayload;
    const gamingSnap = ctx.state.gaming.snapshot();
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
      ctx.channel.sendNotification(`🎮 ${formatPermissionPrompt(payload)}`)
        .catch((e) => ctx.logger.warn('gaming notify failed', { err: (e as Error).message }));
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

    const { requestId, promise } = ctx.pending.create(ctx.config.policy.permissionTimeoutMs);
    try {
      await ctx.channel.sendPrompt({
        requestId,
        text: formatPermissionPrompt(payload),
        buttons: [
          { label: '✅ Allow', action: 'allow' },
          { label: '🔓 Allow & remember', action: 'allow_remember' },
          { label: '❌ Deny', action: 'deny' },
          { label: '💬 Deny with note', action: 'deny_note' },
        ],
      });
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

function projectName(cwd: string | undefined): string {
  if (!cwd) return 'unknown';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}

function formatNotification(p: NotificationPayload): string {
  const folder = projectName(p.cwd);
  const msg = p.message ?? 'Claude Code precisa de atenção.';
  return `[${folder}] ${msg}`;
}

function formatPermissionPrompt(p: PreToolUsePayload): string {
  const folder = projectName(p.cwd);
  const summary = summarizeToolInput(p.tool_name, p.tool_input);
  return `[${folder}] Pode rodar?\n\n${p.tool_name}: ${summary}`;
}

function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return truncate(input.command, 200);
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof input.file_path === 'string') {
    return input.file_path;
  }
  const json = JSON.stringify(input);
  return truncate(json, 200);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function deriveSource(d: Decision): string {
  if (d.decision === 'deny' && d.reason === 'timeout') return 'timeout';
  if (d.decision === 'ask' && d.reason === 'channel unavailable') return 'channel-error';
  return 'telegram';
}
