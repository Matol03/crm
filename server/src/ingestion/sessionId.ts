/**
 * Deterministic session identity (PRD Section 4).
 *
 * `sessionId` is a hash of the sorted messageId list — NOT a random UUID — so
 * re-processing the same underlying messages resolves to the same session and
 * is caught by idempotency (Section 10.4). The timestamp component is likewise
 * derived from the messages (latest item timestamp), never from wall-clock at
 * close time, so the id is stable across re-runs.
 */

import { createHash } from 'node:crypto';

export function hashMessageIds(messageIds: string[]): string {
  const sorted = [...messageIds].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Build the deterministic sessionId. `latestTimestamp` must come from the
 * messages themselves (their max timestamp), not from the clock.
 */
export function makeSessionId(messageIds: string[], latestTimestamp: string): string {
  return `teams|${latestTimestamp}|${hashMessageIds(messageIds)}`;
}
