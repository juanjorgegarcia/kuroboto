import fsp from 'node:fs/promises';
import os from 'node:os';
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

export interface RunningDaemon {
  stop(): Promise<void>;
}

export async function startDaemon(config: ConfigT): Promise<RunningDaemon> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });

  await ensureNoExistingDaemon();

  // Tmux validation only applies to the legacy strategy. PTY-strategy clients
  // self-host their own PTY in `kuroboto claude`, so the daemon needs no
  // multiplexer to start.
  if (config.inject.enabled && config.inject.strategy === 'tmux') {
    await validateTmuxAvailable(config.inject.session ?? 'claude');
  }

  const logger = createLogger(LOG_DIR);
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

  return { stop };
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

