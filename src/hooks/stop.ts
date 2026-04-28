export async function run(): Promise<void> {
  // No-op in MVP. Consume stdin to honor the hook contract.
  for await (const _chunk of process.stdin) {
    void _chunk;
  }
  process.exit(0);
}
