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
