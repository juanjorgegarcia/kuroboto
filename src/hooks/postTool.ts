export async function run(): Promise<void> {
  // No-op. PostToolUse fires whenever Claude executes a tool, which is NOT a signal
  // that the user is back at the desk — using it as a heartbeat would cancel every
  // pending Telegram notification before its delay can fire. Drain stdin to honor
  // the hook contract and exit silently.
  for await (const _chunk of process.stdin) {
    void _chunk;
  }
  process.exit(0);
}
