import type { Decision } from '../core/types.js';
import { readStdin, postToDaemon, getPermissionTimeoutMs } from './util.js';

interface HookSpecificOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

export async function run(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch (e) {
    process.stderr.write(`[kuroboto] pre-tool: bad payload: ${(e as Error).message}\n`);
    // No output → Claude Code applies its normal permission flow.
    process.exit(0);
  }
  const timeoutMs = await getPermissionTimeoutMs();
  const result = await postToDaemon<Decision>('/v1/permission', payload, timeoutMs);
  if (!result.ok) {
    process.stderr.write(`[kuroboto] pre-tool failed: ${result.error}\n`);
    // Fail-open: emit no decision → Claude Code falls back to its own permission UI.
    process.exit(0);
  }
  if (result.data.decision === 'ask') {
    // Daemon explicitly defers to Claude Code's UI.
    process.exit(0);
  }
  const out: HookSpecificOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.data.decision,
      permissionDecisionReason: result.data.reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
