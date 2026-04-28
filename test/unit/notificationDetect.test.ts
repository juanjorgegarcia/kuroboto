import { describe, it, expect } from 'vitest';
import { isQAPrompt } from '../../src/daemon/notificationDetect.js';

describe('isQAPrompt', () => {
  it('returns true for the canonical "Claude is waiting for your input" message', () => {
    expect(isQAPrompt('Claude is waiting for your input')).toBe(true);
  });

  it('returns false for an unrelated notification message', () => {
    expect(isQAPrompt('Task complete')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isQAPrompt('')).toBe(false);
  });

  it('returns false for undefined (resilient against missing payload field)', () => {
    expect(isQAPrompt(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isQAPrompt(null)).toBe(false);
  });

  it('is case-sensitive: subtle variants do not match', () => {
    expect(isQAPrompt('claude is waiting for your input')).toBe(false);
    expect(isQAPrompt('Claude is waiting for your input ')).toBe(false);
  });
});
