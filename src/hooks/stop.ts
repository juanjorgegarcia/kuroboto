export async function run(): Promise<void> {
  // No-op. Stop fires when Claude finishes its turn, which is NOT a signal that the
  // user came back — using it as a heartbeat would race against any Notification
  // that armed during the same turn (e.g. permission prompts answered via Claude UI)
  // and silence the smart-delay push. Drain stdin and exit silently.
  for await (const _chunk of process.stdin) {
    void _chunk;
  }
  process.exit(0);
}
