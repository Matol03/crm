/**
 * Idle-timer buffering — Grouping Tier 1 (PRD Section 6).
 *
 * A session per author opens on their first new message and stays open until
 * either IDLE_TIMEOUT of silence from that author, or a hard MAX_SESSION_DURATION
 * regardless of activity. Grouping is strictly by message *author*, never by
 * Teams thread — a different author's reply in someone's thread is a separate
 * buffer by construction.
 *
 * The clock is injected (`nowMs`) so buffering logic is unit-testable without
 * real timers. The buffer holds no external dependency.
 */

import type { RawChannelMessage } from '../contracts/adapters.js';
import type { SessionBundle, SessionItem } from '../contracts/session.js';
import { makeSessionId } from './sessionId.js';

export interface BufferOptions {
  idleTimeoutMs: number;
  maxSessionDurationMs: number;
}

interface OpenBuffer {
  authorEmail: string;
  channel: { teamsGroupId: string; channelId: string };
  author: { teamsUserId: string; email: string; displayName: string };
  messages: RawChannelMessage[];
  openedAtMs: number;
  lastActivityMs: number;
}

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

export class IdleBuffer {
  private readonly open = new Map<string, OpenBuffer>();

  constructor(private readonly opts: BufferOptions) {}

  /** Number of currently-open author buffers (for tests / metrics). */
  get openCount(): number {
    return this.open.size;
  }

  /**
   * Add a new message to its author's open buffer, creating one if needed.
   * `arrivalMs` defaults to the message timestamp, letting tests drive time
   * purely from message data.
   */
  add(message: RawChannelMessage, arrivalMs = toMs(message.timestamp)): void {
    const key = message.author.email;
    let buf = this.open.get(key);
    if (!buf) {
      buf = {
        authorEmail: key,
        channel: message.channel,
        author: message.author,
        messages: [],
        openedAtMs: arrivalMs,
        lastActivityMs: arrivalMs,
      };
      this.open.set(key, buf);
    }
    buf.messages.push(message);
    buf.lastActivityMs = Math.max(buf.lastActivityMs, arrivalMs);
  }

  /** Should this buffer close at time `nowMs`? */
  private isClosed(buf: OpenBuffer, nowMs: number): boolean {
    const idleExceeded = nowMs - buf.lastActivityMs >= this.opts.idleTimeoutMs;
    const maxExceeded = nowMs - buf.openedAtMs >= this.opts.maxSessionDurationMs;
    return idleExceeded || maxExceeded;
  }

  /**
   * Close and return bundles for every buffer whose idle/max window has elapsed
   * at `nowMs`. Closed buffers are removed from the open set.
   */
  drainClosed(nowMs: number): SessionBundle[] {
    const bundles: SessionBundle[] = [];
    for (const [key, buf] of this.open) {
      if (this.isClosed(buf, nowMs)) {
        bundles.push(this.assemble(buf));
        this.open.delete(key);
      }
    }
    return bundles;
  }

  /** Force-close every open buffer (e.g. on shutdown/drain). */
  flushAll(): SessionBundle[] {
    const bundles: SessionBundle[] = [];
    for (const buf of this.open.values()) bundles.push(this.assemble(buf));
    this.open.clear();
    return bundles;
  }

  /** Assemble an open buffer into the canonical SessionBundle (PRD Section 4). */
  private assemble(buf: OpenBuffer): SessionBundle {
    // Flatten all items across the buffered messages, chronological.
    const items: SessionItem[] = buf.messages
      .flatMap((m) => m.items)
      .sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));

    const messageIds = items.map((i) => i.messageId);
    const timestamps = items.map((i) => toMs(i.timestamp));
    const latestMs = timestamps.length ? Math.max(...timestamps) : buf.lastActivityMs;
    const earliestMs = timestamps.length ? Math.min(...timestamps) : buf.openedAtMs;
    const latestIso = new Date(latestMs).toISOString();

    return {
      sessionId: makeSessionId(messageIds, latestIso),
      channel: buf.channel,
      author: buf.author,
      sessionWindow: {
        openedAt: new Date(earliestMs).toISOString(),
        closedAt: latestIso,
      },
      items,
    };
  }
}
