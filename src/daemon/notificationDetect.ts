// Hardcoded set of known Claude Code Notification messages that mean "Claude
// is paused waiting for free-text input from the user." Anything else falls
// through to the regular notification path.
//
// Extension = add a string to this array.
const QA_PATTERNS: readonly string[] = ['Claude is waiting for your input'];

export function isQAPrompt(message: string | undefined | null): boolean {
  if (typeof message !== 'string') return false;
  return QA_PATTERNS.includes(message);
}

// Sleep sessions emit single-line `[[KUROBOTO]] <text>` markers on stdout for
// mid-flight visibility (Spec J3). Same regex as the stdout parser in
// sleeping.ts; defending in depth here so a stray marker arriving via the
// Notification hook still bypasses the gaming/sleep filter.
export const PROGRESS_MARKER_RE = /^\s*\[\[KUROBOTO\]\]\s+(.+?)\s*$/;

export function isProgressMarker(message: string | undefined | null): boolean {
  if (typeof message !== 'string') return false;
  return PROGRESS_MARKER_RE.test(message);
}
