import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Server } from 'node:http';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { Channel } from '../channels/Channel.js';
import type { ConfigT } from '../config/schema.js';
import { TelegramChannel } from '../channels/telegram/TelegramChannel.js';
import { TelegramApi } from '../channels/telegram/api.js';
import { TopicManager, type TopicAuditEvent } from '../channels/telegram/topics.js';
import { validateBotPermissions } from '../channels/telegram/forumValidation.js';
import { createLogger, type Logger } from '../core/logger.js';
import { CONFIG_DIR, LOG_DIR, PID_FILE, DAEMON_SENTINEL_FILE, TOPICS_FILE } from '../config/paths.js';
import { DaemonError } from '../core/errors.js';
import { PendingMap } from './pending.js';
import { PendingNotifications } from './pendingNotifications.js';
import { PendingReplies } from './pendingReplies.js';
import { loadMode, type Mode } from './state.js';
import { GamingState } from './gaming.js';
import { SleepingOrchestrator } from './sleeping.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { finishSleep } from './sleepFinish.js';
import { notifyDesktop, type DesktopNotifyOpts } from '../notify/desktop.js';
import { createServer, type DaemonContext } from './server.js';
import { createInjectStrategy } from '../inject/index.js';
import { validateTmuxAvailable } from '../inject/validate.js';
import { InjectClients } from './injectClients.js';
import { appendAudit } from './audit.js';
import { topicContextSystem } from './topicContext.js';
import { scanOrphanWorktrees } from './orphanWorktrees.js';

export interface RunningDaemon {
  stop(): Promise<void>;
}

export async function startDaemon(initialConfig: ConfigT): Promise<RunningDaemon> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });

  await ensureNoExistingDaemon();

  const logger = createLogger(LOG_DIR);
  const config = await applyRuntimeFallbacks(initialConfig, logger);
  logger.info('daemon starting', { port: config.daemon.port });

  const channel = await makeChannel(config, logger);
  const pending = new PendingMap();
  pending.startCleanupLoop();
  const pendingNotifications = new PendingNotifications();
  const pendingReplies = new PendingReplies();
  const inject = createInjectStrategy(config.inject);
  const injectClients = new InjectClients();
  const initialMode: Mode = await loadMode();
  const gaming = new GamingState();
  // shell:false so --body markdown passes through verbatim. Node 16+ resolves
  // .exe (and .cmd) via PATHEXT on Windows when shell:false, so we don't need
  // to suffix manually.
  // windowsHide: true suppresses the popup console window when the daemon
  // (which itself may run detached) spawns child processes on Windows. Without
  // this, every sleep agent + every gh/git call flickers a console.
  const claudeSpawn = (cmd: string, args: string[], opts?: SpawnOptions): ReturnType<typeof nodeSpawn> =>
    nodeSpawn(cmd, args, { ...opts, shell: false, windowsHide: true });
  const desktopNotifyDep: ((opts: DesktopNotifyOpts) => Promise<void>) | undefined =
    config.notifications.desktop
      ? (opts) =>
          notifyDesktop(opts, {
            log: (msg, fields) => logger.debug(msg, fields),
          })
      : undefined;
  const sleeping = new SleepingOrchestrator({
    spawn: claudeSpawn,
    gaming,
    notify: (msg, ctx) => channel.sendNotification(msg, ctx),
    audit: async () => {}, // skip audit at daemon level; sleep events go to Telegram
    createWorktree,
    removeWorktree,
    notifyDesktop: desktopNotifyDep,
    logger,
    maxConcurrent: config.policy.maxConcurrentSleeps,
    defaultModel: config.policy.sleepModel,
    onSuccess: (session) =>
      finishSleep(session, {
        exec: async (cmd, args, opts) => {
          return new Promise((resolve) => {
            const child = nodeSpawn(cmd, args, { cwd: opts?.cwd, shell: false, windowsHide: true });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (b) => (stdout += b.toString()));
            child.stderr?.on('data', (b) => (stderr += b.toString()));
            child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
          });
        },
        notify: (msg, ctx) => channel.sendNotification(msg, ctx),
        notifyDesktop: desktopNotifyDep,
      }),
  });
  const state = { mode: initialMode, gaming, sleeping };

  channel.on('decision', (event) => {
    const claimed = pending.resolve(event.requestId, event.decision);
    logger.info('decision received', { requestId: event.requestId, claimed });
  });

  channel.on('freeText', (event) => {
    if (event.replyToMessageId) {
      const claimed = pendingReplies.resolveBySentMessageId(event.replyToMessageId, event.text);
      logger.info('reply received', { sentMessageId: event.replyToMessageId, claimed });
    }
  });

  await channel.start();

  const ctx: DaemonContext = {
    config,
    channel,
    pending,
    pendingNotifications,
    pendingReplies,
    inject,
    injectClients,
    state,
    logger,
    startedAt: Date.now(),
    hostname: os.hostname(),
  };
  const app = createServer(ctx);
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(config.daemon.port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  await fsp.writeFile(PID_FILE, String(process.pid));
  // Sentinel for `kuroboto claude` CLI processes: lets them find the daemon
  // port and re-register themselves on daemon restart via fs.watch.
  try {
    await fsp.writeFile(
      DAEMON_SENTINEL_FILE,
      JSON.stringify({ pid: process.pid, port: config.daemon.port, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch (e) {
    logger.warn('daemon sentinel write failed', { err: (e as Error).message });
  }
  logger.info('daemon ready', { pid: process.pid });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    logger.info('daemon stopping');
    // cancel({ all: true }) — cancel() no-args throws when multi-session,
    // which would silently leave orphan children on shutdown.
    state.sleeping.cancel({ all: true }).catch(() => {});
    pending.drainAll('shutdown');
    pending.stopCleanupLoop();
    pendingNotifications.cancelAll();
    pendingReplies.cancelAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await channel.sendNotification('🔻 kuroboto offline', topicContextSystem());
    } catch {
      // best-effort
    }
    await channel.stop();
    try {
      await fsp.unlink(PID_FILE);
    } catch {
      // best-effort
    }
    try {
      await fsp.unlink(DAEMON_SENTINEL_FILE);
    } catch {
      // best-effort
    }
    logger.info('daemon stopped');
  };

  const onSignal = (sig: NodeJS.Signals) => {
    logger.info('signal received', { sig });
    stop()
      .then(() => process.exit(0))
      .catch((e) => {
        logger.error('shutdown error', { err: (e as Error).message });
        process.exit(1);
      });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    await channel.sendNotification('✅ kuroboto online', topicContextSystem());
  } catch {
    // best-effort
  }

  // Spec G v1: surface sleep worktrees that look orphaned after a watchdog
  // respawn or hard restart. Best-effort — failures don't block startup.
  void announceOrphanedWorktrees(config, channel, logger);

  return { stop };
}

async function announceOrphanedWorktrees(
  config: ConfigT,
  channel: Channel,
  logger: Logger,
): Promise<void> {
  try {
    const workRoot = expandHome(config.policy.sleepWorktreeDir);
    const orphans = await scanOrphanWorktrees({
      workRoot,
      log: (msg, fields) => logger.info(msg, fields),
      listOpenSleepBranches: () => listOpenSleepBranchesViaGh(logger),
    });
    if (orphans.length === 0) return;
    for (const o of orphans) {
      await channel
        .sendNotification(
          `⚠️ sleep ${o.slug} ficou órfão durante restart; investigar manualmente`,
          topicContextSystem(),
        )
        .catch(() => {
          // best-effort
        });
    }
  } catch (e) {
    logger.warn('orphan worktree scan failed', { err: (e as Error).message });
  }
}

function expandHome(dir: string): string {
  if (dir.startsWith('~/') || dir === '~') {
    return path.join(os.homedir(), dir.slice(1).replace(/^[\\/]/, ''));
  }
  return dir;
}

async function listOpenSleepBranchesViaGh(logger: Logger): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = nodeSpawn(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'headRefName', '--limit', '100'],
      { shell: false, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (e) => {
      logger.warn('gh pr list spawn error', { err: e.message });
      resolve(new Set());
    });
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('gh pr list non-zero', { code, stderr: stderr.trim().slice(0, 200) });
        resolve(new Set());
        return;
      }
      try {
        const prs = JSON.parse(stdout) as Array<{ headRefName: string }>;
        const slugs = new Set<string>();
        for (const pr of prs) {
          if (pr.headRefName?.startsWith('sleep/')) {
            slugs.add(pr.headRefName.slice('sleep/'.length));
          }
        }
        resolve(slugs);
      } catch (e) {
        logger.warn('gh pr list parse failed', { err: (e as Error).message });
        resolve(new Set());
      }
    });
  });
}

async function ensureNoExistingDaemon(): Promise<void> {
  let pidStr: string;
  try {
    pidStr = await fsp.readFile(PID_FILE, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const pid = Number.parseInt(pidStr.trim(), 10);
  if (!Number.isFinite(pid)) {
    await fsp.unlink(PID_FILE);
    return;
  }
  if (isProcessAlive(pid)) {
    throw new DaemonError(`daemon already running, PID=${pid}`);
  }
  await fsp.unlink(PID_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Tmux is a legacy inject strategy. PTY-strategy clients self-host their own
// PTY in `kuroboto claude`, so the daemon doesn't need a multiplexer at all.
// When the user's persisted config still says `tmux` but tmux isn't available
// (server died, session not running, binary missing), fall back to pty for
// this run instead of refusing to start. The config file is left alone — a
// transient tmux outage shouldn't rewrite their preference.
async function applyRuntimeFallbacks(config: ConfigT, logger: Logger): Promise<ConfigT> {
  if (!config.inject.enabled || config.inject.strategy !== 'tmux') return config;
  try {
    await validateTmuxAvailable(config.inject.session ?? 'claude');
    return config;
  } catch (e) {
    const reason = (e as Error).message;
    logger.warn('tmux strategy unavailable, falling back to pty', { err: reason });
    process.stderr.write(
      `[kuroboto] tmux unavailable (${reason}); falling back to pty for this run\n`,
    );
    return { ...config, inject: { ...config.inject, strategy: 'pty', session: undefined } };
  }
}

async function makeChannel(config: ConfigT, logger: Logger): Promise<Channel> {
  if (config.channel.type === 'telegram') {
    if (config.channel.forumMode) {
      const api = new TelegramApi(config.channel.token);
      // Fail fast if the bot can't manage topics — saves chasing a 400 on
      // the first sendMessage and gives the user actionable instructions.
      await validateBotPermissions(api, config.channel.chatId);
      const topicManager = new TopicManager({
        api,
        chatId: config.channel.chatId,
        forumMode: true,
        storagePath: TOPICS_FILE,
        logger,
        audit: forwardTopicAudit(logger),
      });
      await topicManager.loadFromDisk();
      return new TelegramChannel({
        token: config.channel.token,
        chatId: config.channel.chatId,
        logger,
        topicManager,
      });
    }
    return new TelegramChannel({
      token: config.channel.token,
      chatId: config.channel.chatId,
      logger,
    });
  }
  throw new DaemonError(`unsupported channel type: ${(config.channel as { type: string }).type}`);
}

function forwardTopicAudit(logger: Logger): (e: TopicAuditEvent) => void {
  return (e) => {
    // Topic lifecycle is not a permission decision; we audit the event but
    // map decisions semantically: success (created/purged) = allow, failure
    // = deny. 'ask' would imply pending/timeout and doesn't fit any topic
    // event shape.
    const decision: 'allow' | 'deny' = e.source === 'topic-create-failed' ? 'deny' : 'allow';
    appendAudit({
      ts: new Date().toISOString(),
      requestId: e.threadId !== undefined ? `topic:${e.threadId}` : `topic:${e.key}`,
      tool: 'topic',
      cwd: null,
      decision,
      reason: e.error ?? null,
      source: e.source,
      remember: false,
    }).catch((err) => logger.warn('topic audit append failed', { err: (err as Error).message }));
  };
}

