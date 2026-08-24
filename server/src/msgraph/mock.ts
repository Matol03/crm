/**
 * Mock Microsoft Graph client (PRD Section 4, mock mode).
 *
 * Serves queued channel messages filtered by `since` and captures posted
 * replies in memory (so tests can assert the manager was answered without a
 * real Teams post). A real app-only/delegated Graph client will implement the
 * same interface (`getNewChannelMessages` / `postReply`).
 */

import type { MsGraphClient, RawChannelMessage } from '../contracts/adapters.js';
import type { AttachmentRef } from '../contracts/session.js';

export interface CapturedReply {
  channel: { teamsGroupId: string; channelId: string };
  threadId: string | null;
  text: string;
}

export class MockMsGraphClient implements MsGraphClient {
  private readonly inbox: RawChannelMessage[];
  readonly postedReplies: CapturedReply[] = [];
  /** Optional canned attachment bytes, keyed by ref. */
  private readonly attachments = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  constructor(messages: RawChannelMessage[] = []) {
    // Keep chronological, as Graph would return by lastModifiedDateTime.
    this.inbox = [...messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /** Test helper: make bytes available for a given attachment reference. */
  registerAttachment(key: string, bytes: Uint8Array, mimeType = 'image/png'): void {
    this.attachments.set(key, { bytes, mimeType });
  }

  /** Test helper: enqueue more messages (e.g. a delayed backfill). */
  enqueue(...messages: RawChannelMessage[]): void {
    this.inbox.push(...messages);
    this.inbox.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  async getNewChannelMessages(since: string): Promise<RawChannelMessage[]> {
    const sinceMs = since ? new Date(since).getTime() : 0;
    return this.inbox.filter((m) => new Date(m.timestamp).getTime() > sinceMs);
  }

  /**
   * Fixtures carry their card text inline (`ocrText`), so nothing needs
   * downloading. Registered bytes can still be supplied for tests that exercise
   * the OCR path.
   */
  async fetchAttachment(ref: AttachmentRef): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const key = ref.kind === 'hosted' ? `${ref.messageId}:${ref.contentId}` : ref.url;
    return this.attachments.get(key) ?? null;
  }

  async postReply(
    channel: { teamsGroupId: string; channelId: string },
    threadId: string | null,
    text: string,
  ): Promise<void> {
    this.postedReplies.push({ channel, threadId, text });
  }
}
