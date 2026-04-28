import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { checkHealth } from './util.js';
import { startCommand } from './start.js';
import { runInjectClient, installCrashSafety } from './injectClient.js';

export interface ClaudeOpts {
  tmux: boolean;
  name?: string;
  forward: string[];
}

export async function claudeCommand(args: string[]): Promise<void> {
  const opts = parseOpts(args);
  const health = await checkHealth();
  if (!health.ok) {
    console.log(chalk.dim('[kuroboto] daemon offline, subindo em background…'));
    await startCommand({ detach: true });
  }
  if (opts.tmux) {
    runLegacyTmux(opts.forward);
    return;
  }
  installCrashSafety();
  const result = await runInjectClient({ args: opts.forward, name: opts.name });
  process.exit(result.exitCode);
}

/**
 * Strip kuroboto-owned flags (`--tmux`, `--name <slug>`) from the head of
 * the forwarded args. Anything we don't recognise — including unknown flags —
 * is forwarded verbatim to claude.
 */
export function parseOpts(args: string[]): ClaudeOpts {
  let tmux = false;
  let name: string | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--tmux') {
      tmux = true;
      i += 1;
      continue;
    }
    if (a === '--name') {
      name = args[i + 1];
      i += 2;
      continue;
    }
    if (a.startsWith('--name=')) {
      name = a.slice('--name='.length);
      i += 1;
      continue;
    }
    break;
  }
  return { tmux, name, forward: args.slice(i) };
}

function runLegacyTmux(args: string[]): void {
  // Legacy path: spawn claude with stdio:inherit. Same as before the PTY
  // wrapper landed; daemon's tmux strategy will do send-keys.
  const child = spawn('claude', args, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    console.error(chalk.red(`[kuroboto] failed to spawn claude: ${e.message}`));
    process.exit(1);
  });
}
