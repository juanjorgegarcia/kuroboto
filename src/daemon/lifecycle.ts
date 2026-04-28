import fsp from 'node:fs/promises';
import { type Server } from 'node:http';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { Channel } from '../channels/Channel.js';
import type { ConfigT } from '../config/schema.js';
import { TelegramChannel } from '../channels/telegram/TelegramChannel.js';
import { createLogger, type Logger } from '../core/logger.js';
import { CONFIG_DIR, LOG_DIR, PID_FILE } from '../config/paths.js';
import { DaemonError } from '../core/errors.js';
import { PendingMap } from './pending.js';
import { PendingNotifications } from './pendingNotifications.js';
import { loadMode, type Mode } from './state.js';
import { GamingState } from './gaming.js';
import { SleepingOrchestrator } from './sleeping.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { finishSleep } from './sleepFinish.js';
import { createServer, type DaemonContext } from './server.js';

export interface RunningDaemon {
  stop(): Promise<void>;
}

export async function startDaemon(config: ConfigT): Promise<RunningDaemon> {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.mkdir(LOG_DIR, { recursive: true });

  await ensureNoExistingDaemon();

  const logger = createLogger(LOG_DIR);
  logger.info('daemon starting', { port: config.daemon.port });

  const channel = makeChannel(config, logger);
  const pending = new PendingMap();
  pending.startCleanupLoop();
  const pendingNotifications = new PendingNotifications();
  const initialMode: Mode = await loadMode();
  const gaming = new GamingState();
  const claudeSpawn = (cmd: string, args: string[], opts?: SpawnOptions): ReturnType<typeof nodeSpawn> =>
    nodeSpawn(cmd, args, { ...opts, shell: true });
  const sleeping = new SleepingOrchestrator({
    spawn: claudeSpawn,
    gaming,
    notify: (msg) => channel.sendNotification(msg),
    audit: async () => {}, // skip audit at daemon level; sleep events go to Telegram
    createWorktree,
    removeWorktree,
    onSuccess: (session) =>
      finishSleep(session, {
        exec: async (cmd, args, opts) => {
          return new Promise((resolve) => {
            const child = nodeSpawn(cmd, args, { cwd: opts?.cwd, shell: true });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (b) => (stdout += b.toString()));
            child.stderr?.on('data', (b) => (stderr += b.toString()));
            child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
          });
        },
        notify: (msg) => channel.sendNotification(msg),
      }),
  });
  const state = { mode: initialMode, gaming, sleeping };

  channel.on('decision', (event) => {
    const claimed = pending.resolve(event.requestId, event.decision);
    logger.info('decision received', { requestId: event.requestId, claimed });
  });

  await channel.start();

  const ctx: DaemonContext = {
    config,
    channel,
    pending,
    pendingNotifications,
    state,
    logger,
    startedAt: Date.now(),
  };
  const app = createServer(ctx);
  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(config.daemon.port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  await fsp.writeFile(PID_FILE, String(process.pid));
  logger.info('daemon ready', { pid: process.pid });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    logger.info('daemon stopping');
    state.sleeping.cancel().catch(() => {});
    pending.drainAll('shutdown');
    pending.stopCleanupLoop();
    pendingNotifications.cancelAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await channel.sendNotification('🔻 kuroboto offline');
    } catch {
      // best-effort
    }
    await channel.stop();
    try {
      await fsp.unlink(PID_FILE);
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
    await channel.sendNotification('✅ kuroboto online');
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

function makeChannel(config: ConfigT, logger: Logger): Channel {
  if (config.channel.type === 'telegram') {
    return new TelegramChannel({
      token: config.channel.token,
      chatId: config.channel.chatId,
      logger,
    });
  }
  throw new DaemonError(`unsupported channel type: ${(config.channel as { type: string }).type}`);
}
