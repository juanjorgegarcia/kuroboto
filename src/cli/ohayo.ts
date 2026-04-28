import { spawn, spawnSync } from 'node:child_process';
import chalk from 'chalk';

const SESSION = 'claude';
const STARTUP_COMMAND = 'kuroboto claude';

function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmuxHasSession(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

export async function ohayoCommand(): Promise<void> {
  console.log(chalk.bold('ohayo 🌅'));

  if (!tmuxAvailable()) {
    console.error(chalk.red('tmux not found on PATH. Install tmux first (or use `kuroboto claude` for the no-tmux flow).'));
    process.exit(1);
  }

  if (!tmuxHasSession(SESSION)) {
    console.log(chalk.dim(`creating tmux session "${SESSION}"…`));
    // Step 1: detached empty session (avoids tmux-windows quirks with `-d -c`
    // and with shell-command passed as a single arg to new-session).
    const create = spawnSync('tmux', ['new-session', '-d', '-s', SESSION], { stdio: 'inherit' });
    if (create.status !== 0) {
      console.error(chalk.red(`failed to create tmux session (exit ${create.status})`));
      process.exit(1);
    }
    // Step 2: paste the startup command into the session's first pane.
    const send = spawnSync(
      'tmux',
      ['send-keys', '-t', SESSION, STARTUP_COMMAND, 'Enter'],
      { stdio: 'inherit' },
    );
    if (send.status !== 0) {
      console.error(chalk.red(`failed to send keys to tmux session (exit ${send.status})`));
      process.exit(1);
    }
    console.log(chalk.dim(`session ready, attaching…`));
  } else {
    console.log(chalk.dim(`attaching to existing tmux session "${SESSION}"…`));
  }

  // Step 3: attach in foreground.
  const child = spawn('tmux', ['attach-session', '-t', SESSION], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
  child.on('error', (e) => {
    console.error(chalk.red(`tmux attach failed: ${e.message}`));
    process.exit(1);
  });
}
