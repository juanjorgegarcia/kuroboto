#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { statusCommand } from './status.js';
import { hookCommand } from './hook.js';
import { claudeCommand } from './claude.js';
import { hereCommand, awayCommand } from './mode.js';
import { ohayoCommand } from './ohayo.js';
import { allowlistList, allowlistExport } from './allowlist.js';
import { auditList, auditExport } from './audit.js';
import { gamingOnCommand, gamingOffCommand, gamingStatusCommand } from './gaming.js';
import { sleepingStartCommand, sleepingCancelCommand, sleepingStatusCommand } from './sleeping.js';

// Special-case: `kuroboto claude [...args]` forwards everything raw to Claude Code.
// Commander would otherwise eat global flags like --version / --help before they
// reach the subcommand action.
const claudeIdx = process.argv.indexOf('claude');
const claudeShortcut =
  claudeIdx >= 2 && process.argv.slice(2, claudeIdx).every((a) => !a.startsWith('-'));

if (claudeShortcut) {
  const forward = process.argv.slice(claudeIdx + 1);
  claudeCommand(forward).catch((e) => {
    console.error(`claude wrapper failed: ${(e as Error).message}`);
    process.exit(1);
  });
}

const program = new Command();

program
  .name('kuroboto')
  .description('Respond to Claude Code prompts from your phone via chat (Telegram first).')
  .version('0.1.0');

program
  .command('init')
  .description('Interactive setup: bot token, chat_id, hooks in ~/.claude/settings.json')
  .action(async () => {
    try {
      await initCommand();
    } catch (e) {
      console.error(`init failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start the daemon')
  .option('-d, --detach', 'Run as detached background process', false)
  .action(async (opts: { detach: boolean }) => {
    try {
      await startCommand(opts);
    } catch (e) {
      console.error(`start failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('SIGTERM the daemon and drain pending requests')
  .action(async () => {
    try {
      await stopCommand();
    } catch (e) {
      console.error(`stop failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show daemon, channel, and hook installation state')
  .action(async () => {
    try {
      await statusCommand();
    } catch (e) {
      console.error(`status failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('ohayo')
  .description('Morning ritual: tmux session "claude" + daemon + Claude Code, all wired')
  .action(async () => {
    try {
      await ohayoCommand();
    } catch (e) {
      console.error(`ohayo failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('here')
  .description('Switch to "here" mode (notifications delayed; permissions go to Claude UI)')
  .action(async () => {
    try {
      await hereCommand();
    } catch (e) {
      console.error(`here failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('away')
  .description('Switch to "away" mode (notifications immediate; permissions go to Telegram)')
  .action(async () => {
    try {
      await awayCommand();
    } catch (e) {
      console.error(`away failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('claude')
  .description('Open Claude Code with daemon ensured up and hooks active')
  .allowUnknownOption(true)
  .argument('[args...]', 'Arguments forwarded to claude')
  .action(async (args: string[]) => {
    try {
      await claudeCommand(args ?? []);
    } catch (e) {
      console.error(`claude wrapper failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('hook <type>')
  .description('Internal — invoked by Claude Code hooks (do not call directly)')
  .action(async (type: string) => {
    try {
      await hookCommand(type);
    } catch (e) {
      process.stderr.write(`[kuroboto] hook ${type} crashed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  });

const gaming = program.command('gaming').description('Auto-allow all permission prompts (full carta-branca)');
gaming
  .command('on [duration]')
  .description('Turn gaming mode on. Optional duration like `15m`, `2h`, `30s` for auto-off.')
  .action(async (duration?: string) => {
    try {
      await gamingOnCommand(duration);
    } catch (e) {
      console.error(`gaming on failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });
gaming
  .command('off')
  .description('Turn gaming mode off (back to normal here/away flow)')
  .action(async () => {
    try {
      await gamingOffCommand();
    } catch (e) {
      console.error(`gaming off failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });
gaming
  .command('status')
  .description('Show gaming on/off and remaining time if a timer is active')
  .action(async () => {
    try {
      await gamingStatusCommand();
    } catch (e) {
      console.error(`gaming status failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

const sleeping = program.command('sleeping').description('Run a plan/prompt autonomously in a worktree (sleep mode)');
sleeping
  .command('start')
  .description('Start a sleep session — Claude implements a plan/prompt while you are away')
  .option('--prompt <text>', 'free-form prompt for Claude (mutually exclusive with --plan)')
  .option('--plan <file>', 'path to a plan markdown file (mutually exclusive with --prompt)')
  .option('--repo <path>', 'repo to operate on (default: cwd)')
  .option('--max <duration>', 'max duration like 2h, 30m (default: policy.sleepMaxDurationMs)')
  .action(async (opts: { prompt?: string; plan?: string; repo?: string; max?: string }) => {
    try {
      await sleepingStartCommand(opts);
    } catch (e) {
      console.error(`sleeping start failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });
sleeping
  .command('cancel')
  .description('Cancel the active sleep session (worktree is left intact for inspection)')
  .action(async () => {
    try {
      await sleepingCancelCommand();
    } catch (e) {
      console.error(`sleeping cancel failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });
sleeping
  .command('status')
  .description('Show whether a sleep session is active')
  .action(async () => {
    try {
      await sleepingStatusCommand();
    } catch (e) {
      console.error(`sleeping status failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

const allowlist = program.command('allowlist').description('Inspect the project allowlist (.claude/settings.local.json)');
allowlist
  .command('list [dir]')
  .description('List allow matchers for the given dir (default: cwd)')
  .action(async (dir?: string) => {
    try {
      await allowlistList(dir ?? process.cwd());
    } catch (e) {
      console.error(`allowlist list failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });
allowlist
  .command('export [dir]')
  .description('Print full settings.local.json as JSON')
  .action(async (dir?: string) => {
    try {
      await allowlistExport(dir ?? process.cwd());
    } catch (e) {
      console.error(`allowlist export failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

const audit = program.command('audit').description('Inspect the kuroboto decision audit log');
audit
  .command('list')
  .option('--since <duration>', 'e.g. 30s, 5m, 2h, 7d')
  .option('--cwd <path>', 'filter by cwd')
  .option('--limit <n>', 'show only the last N entries')
  .description('Print decisions in human-readable format')
  .action(async (opts) => {
    try {
      await auditList(opts);
    } catch (e) {
      console.error(`audit list failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });
audit
  .command('export')
  .option('--since <duration>', 'e.g. 30s, 5m, 2h, 7d')
  .option('--cwd <path>', 'filter by cwd')
  .option('--limit <n>', 'show only the last N entries')
  .description('Print decisions as raw JSONL (one per line)')
  .action(async (opts) => {
    try {
      await auditExport(opts);
    } catch (e) {
      console.error(`audit export failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

if (!claudeShortcut) {
  program.parseAsync(process.argv).catch((e) => {
    console.error(`fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
