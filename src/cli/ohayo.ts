import { spawn, spawnSync } from 'node:child_process';
import chalk from 'chalk';

const SESSION = 'claude';

function tmuxHasSession(session: string): boolean {
  const r = spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
  return r.status === 0;
}

function tmuxAvailable(): boolean {
  const r = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return r.status === 0;
}

export async function ohayoCommand(): Promise<void> {
  console.log(chalk.bold('ohayo 🌅'));

  if (!tmuxAvailable()) {
    console.error(chalk.red('tmux not found on PATH. Install tmux first (or use `kuroboto claude` for the no-tmux flow).'));
    process.exit(1);
  }

  const exists = tmuxHasSession(SESSION);
  if (exists) {
    console.log(chalk.dim(`attaching to tmux session "${SESSION}"…`));
    const child = spawn('tmux', ['attach-session', '-t', SESSION], { stdio: 'inherit' });
    child.on('exit', (c) => process.exit(c ?? 0));
    child.on('error', (e) => {
      console.error(chalk.red(`tmux failed: ${e.message}`));
      process.exit(1);
    });
    return;
  }

  console.log(chalk.dim(`creating tmux session "${SESSION}" — daemon will be started by \`kuroboto claude\` inside…`));
  // tmux passes the shell-command as a single arg; we pass `kuroboto claude` so
  // the daemon-ensure logic runs inside the new pane.
  const child = spawn('tmux', ['new-session', '-s', SESSION, 'kuroboto claude'], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
  child.on('error', (e) => {
    console.error(chalk.red(`tmux failed: ${e.message}`));
    process.exit(1);
  });
}
