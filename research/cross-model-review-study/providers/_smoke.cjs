// Quick standalone smoke test of the CliProvider — bypasses promptfoo so we
// catch shape/spawn bugs before wiring 5+ instances into the config.
const Provider = require('./cli-provider.cjs');

const cases = [
  {
    label: 'claude-sonnet-4-6',
    config: {
      command: 'claude',
      args: ['--print', '--model', 'claude-sonnet-4-6'],
      timeoutMs: 60_000,
    },
  },
  {
    label: 'claude-opus-4-7',
    config: {
      command: 'claude',
      args: ['--print', '--model', 'claude-opus-4-7'],
      timeoutMs: 90_000,
    },
  },
  {
    label: 'codex-default',
    config: {
      command: 'codex.cmd',
      args: ['exec'],
      timeoutMs: 120_000,
      stripPatterns: [
        // codex banner up to and including the first --------\nuser\n line
        { pattern: '^[\\s\\S]*?--------\\s*\\nuser\\s*\\n[\\s\\S]*?\\n', flags: '' },
        // tokens used / footer
        { pattern: '\\ntokens used[\\s\\S]*$', flags: '' },
      ],
    },
  },
  {
    label: 'gemini-default',
    config: {
      command: 'gemini.cmd',
      args: [],
      timeoutMs: 60_000,
    },
  },
  {
    label: 'copilot-default',
    config: {
      command: 'copilot',
      args: [],
      timeoutMs: 60_000,
      stripPatterns: [
        // Footer: blank line + "Changes ... Requests ... Tokens ..."
        { pattern: '\\n\\s*Changes[\\s\\S]*$', flags: '' },
      ],
    },
  },
];

(async () => {
  for (const c of cases) {
    process.stdout.write(`\n=== ${c.label} ===\n`);
    const p = new Provider({ id: c.label, label: c.label, config: c.config });
    const result = await p.callApi('Reply with single word only: pong');
    if (result.error) {
      process.stdout.write(`ERR: ${result.error}\n`);
    } else {
      process.stdout.write(`output: ${JSON.stringify(result.output)}\n`);
      process.stdout.write(`duration: ${result.metadata?.durationMs}ms\n`);
    }
  }
})();
