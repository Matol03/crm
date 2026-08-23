/**
 * Mock Microsoft Graph client (PRD Section 4, mock mode).
 *
 * Serves queued channel messages filtered by `since` and captures posted
 * replies in memory (so tests can assert the manager was answered without a
 * real Teams post). A real app-only/delegated Graph client will implement the
 * same interface (`getNewChannelMessages` / `postReply`).
 */

import type { MsGraphClient, RawChannelMessage } from '../contracts/adapters.js';

export interface CapturedReply {
  channel: { teamsGroupId: string; channelId: string };
  threadId: string | null;
  text: string;
}

export class MockMsGraphClient implements MsGraphClient {
  private readonly inbox: RawChannelMessage[];
  readonly postedReplies: CapturedReply[] = [];

  constructor(messages: RawChannelMessage[] = []) {
    // Keep chronological, as Graph would return by lastModifiedDateTime.
    this.inbox = [...messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
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

  async postReply(
    channel: { teamsGroupId: string; channelId: string },
    threadId: string | null,
    text: string,
  ): Promise<void> {
    this.postedReplies.push({ channel, threadId, text });
  }
}
