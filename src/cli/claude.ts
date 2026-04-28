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
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(chalk.red(`[kuroboto] failed to spawn claude: ${e.message}`));
    process.exit(1);
  });
}
