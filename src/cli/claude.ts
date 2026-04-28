import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { checkHealth } from './util.js';
import { startCommand } from './start.js';

export async function claudeCommand(args: string[]): Promise<void> {
  const health = await checkHealth();
  if (!health.ok) {
    console.log(chalk.dim('[kuroboto] daemon offline, subindo em background…'));
    await startCommand({ detach: true });
  }
  // Use bare `claude` and let the shell resolve the right extension via PATHEXT
  // (claude.exe, claude.cmd, claude.bat, ...). Hard-coding `.cmd` broke installs
  // that ship `.exe` (e.g. ~/.local/bin/claude.exe).
  const child = spawn('claude', args, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(chalk.red(`[kuroboto] failed to spawn claude: ${e.message}`));
    process.exit(1);
  });
}
