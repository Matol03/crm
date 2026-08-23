import { describe, it, expect } from 'vitest';
import { IdleBuffer } from '../src/ingestion/buffer.js';
import { makeSessionId, hashMessageIds } from '../src/ingestion/sessionId.js';
import type { RawChannelMessage } from '../src/contracts/index.js';

const CHANNEL = { teamsGroupId: 'g1', channelId: 'c1' };
const A = { teamsUserId: 'ua', email: 'a@x.com', displayName: 'A' };
const B = { teamsUserId: 'ub', email: 'b@x.com', displayName: 'B' };

function msg(id: string, authorEmail: typeof A, ms: number): RawChannelMessage {
  return {
    messageId: id,
    timestamp: new Date(ms).toISOString(),
    author: authorEmail,
    channel: CHANNEL,
    items: [{ messageId: id, timestamp: new Date(ms).toISOString(), type: 'text', text: id }],
  };
}

describe('sessionId', () => {
  it('is deterministic regardless of messageId order', () => {
    expect(hashMessageIds(['b', 'a', 'c'])).toBe(hashMessageIds(['a', 'b', 'c']));
    expect(makeSessionId(['m2', 'm1'], '2026-01-01T00:00:00.000Z')).toBe(
      makeSessionId(['m1', 'm2'], '2026-01-01T00:00:00.000Z'),
    );
  });
  it('changes when the message set changes', () => {
    expect(hashMessageIds(['a', 'b'])).not.toBe(hashMessageIds(['a', 'b', 'c']));
  });
});

describe('IdleBuffer', () => {
  const opts = { idleTimeoutMs: 240_000, maxSessionDurationMs: 900_000 };

  it('closes a buffer after idle timeout and emits a bundle', () => {
    const buf = new IdleBuffer(opts);
    const t0 = Date.parse('2026-08-22T10:00:00Z');
    buf.add(msg('m1', A, t0), t0);
    buf.add(msg('m2', A, t0 + 30_000), t0 + 30_000);
    // Not yet idle.
    expect(buf.drainClosed(t0 + 60_000)).toHaveLength(0);
    // Idle exceeded (last activity + 240s).
    const closed = buf.drainClosed(t0 + 30_000 + 240_000);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.items.map((i) => i.messageId)).toEqual(['m1', 'm2']);
    expect(buf.openCount).toBe(0);
  });

  it('keeps different authors in separate buffers (never folds cross-author)', () => {
    const buf = new IdleBuffer(opts);
    const t0 = Date.parse('2026-08-22T10:00:00Z');
    buf.add(msg('a1', A, t0), t0);
    buf.add(msg('b1', B, t0 + 1000), t0 + 1000); // B replies in the same window
    expect(buf.openCount).toBe(2);
    const closed = buf.drainClosed(t0 + 500_000).sort((x, y) => x.author.email.localeCompare(y.author.email));
    expect(closed).toHaveLength(2);
    expect(closed[0]!.author.email).toBe('a@x.com');
    expect(closed[0]!.items.map((i) => i.messageId)).toEqual(['a1']);
    expect(closed[1]!.items.map((i) => i.messageId)).toEqual(['b1']);
  });

  it('enforces the hard max-session cap even with continuous activity', () => {
    const buf = new IdleBuffer(opts);
    const t0 = Date.parse('2026-08-22T10:00:00Z');
    buf.add(msg('m1', A, t0), t0);
    // Keep talking every 60s past the 15-min cap.
    for (let k = 1; k <= 16; k++) buf.add(msg(`m${k + 1}`, A, t0 + k * 60_000), t0 + k * 60_000);
    const closed = buf.drainClosed(t0 + 16 * 60_000);
    expect(closed).toHaveLength(1); // max duration (900s) exceeded at 960s
  });
});
