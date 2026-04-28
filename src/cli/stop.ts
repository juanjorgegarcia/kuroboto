import chalk from 'chalk';
import { readPid, isProcessAlive, sleep } from './util.js';

export async function stopCommand(): Promise<void> {
  const pid = await readPid();
  if (!pid || !isProcessAlive(pid)) {
    console.log(chalk.yellow('nenhum daemon rodando'));
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      console.log(chalk.green('daemon parado'));
      return;
    }
    await sleep(200);
  }
  console.error(chalk.red('daemon não parou em 10s'));
  process.exitCode = 1;
}
