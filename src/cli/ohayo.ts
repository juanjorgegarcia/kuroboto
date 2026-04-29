import { spawn, spawnSync } from 'node:child_process';
import chalk from 'chalk';
import { checkHealth } from './util.js';
import { startCommand } from './start.js';
import { runInjectClient, installCrashSafety } from './injectClient.js';

const TMUX_SESSION = 'claude';
const TMUX_STARTUP_COMMAND = 'kuroboto claude';

export interface OhayoOpts {
  tmux?: boolean;
}

export async function ohayoCommand(opts: OhayoOpts = {}): Promise<void> {
  console.log(chalk.bold('ohayo 🌅'));

  const health = await checkHealth();
  if (!health.ok) {
    console.log(chalk.dim('[kuroboto] daemon offline, subindo em background…'));
    await startCommand({ detach: true });
  }

  if (opts.tmux) {
    runTmux();
    return;
  }

  // Default: PTY-wrap claude in this terminal — no tmux overlay, no
  // intercepted bell, daemon Q&A still works via the inject client.
  installCrashSafety();
  const result = await runInjectClient({ args: [] });
  process.exit(result.exitCode);
}

function runTmux(): void {
  if (!tmuxAvailable()) {
    console.error(chalk.red('tmux not found on PATH. Install tmux first or drop the --tmux flag.'));
    process.exit(1);
  }
  if (!tmuxHasSession(TMUX_SESSION)) {
    console.log(chalk.dim(`creating tmux session "${TMUX_SESSION}"…`));
    const create = spawnSync('tmux', ['new-session', '-d', '-s', TMUX_SESSION], { stdio: 'inherit' });
    if (create.status !== 0) {
      console.error(chalk.red(`failed to create tmux session (exit ${create.status})`));
      process.exit(1);
    }
    const send = spawnSync(
      'tmux',
      ['send-keys', '-t', TMUX_SESSION, TMUX_STARTUP_COMMAND, 'Enter'],
      { stdio: 'inherit' },
    );
    if (send.status !== 0) {
      console.error(chalk.red(`failed to send keys to tmux session (exit ${send.status})`));
      process.exit(1);
    }
    console.log(chalk.dim(`session ready, attaching…`));
  } else {
    console.log(chalk.dim(`attaching to existing tmux session "${TMUX_SESSION}"…`));
  }
  const child = spawn('tmux', ['attach-session', '-t', TMUX_SESSION], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
  child.on('error', (e) => {
    console.error(chalk.red(`tmux attach failed: ${e.message}`));
    process.exit(1);
  });
}

function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmuxHasSession(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}
