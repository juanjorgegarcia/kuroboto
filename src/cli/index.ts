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

if (!claudeShortcut) {
  program.parseAsync(process.argv).catch((e) => {
    console.error(`fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
