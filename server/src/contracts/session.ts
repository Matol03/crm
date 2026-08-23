/**
 * Canonical internal data contract for the pipeline (PRD Section 4).
 *
 * A `SessionBundle` is what ingestion produces once an idle timer closes a
 * per-author buffer. It is the shape stored in `sessions.raw_payload_json` and
 * the input to grouping -> extraction -> mapping -> bitrix.
 *
 * Every field on an item except `messageId` / `timestamp` / `type` is optional;
 * the pipeline must tolerate any combination being missing.
 */

export type ItemType = 'text' | 'image' | 'voice';

/** A single Teams message (or attachment) inside a session bundle. */
export interface SessionItem {
  messageId: string;
  /** ISO-8601 timestamp of the message. */
  timestamp: string;
  type: ItemType;
  /** Present for `text` items (and optionally as a caption on others). */
  text?: string;
  /** Present for `voice` items once ASR has run. */
  transcript?: string;
  /** Present for `image` items once OCR has run (null until read). */
  ocrText?: string | null;
  /** Graph/SharePoint URL for the underlying media, when applicable. */
  mediaUrl?: string;
  /**
   * True when Teams surfaced the message before the attachment bytes were
   * retrievable. The lead is created anyway and flagged for later retry
   * (PRD Section 4 / 10.4).
   */
  attachmentPending?: boolean;
}

export interface SessionChannel {
  teamsGroupId: string;
  channelId: string;
}

export interface SessionAuthor {
  teamsUserId: string;
  email: string;
  displayName: string;
}

export interface SessionWindow {
  openedAt: string;
  closedAt: string;
}

export interface SessionBundle {
  /**
   * Deterministic id: `teams|<closedAt>|<hash-of-sorted-messageIds>`.
   * NOT a random UUID — re-processing the same underlying messages resolves to
   * the same session and is caught by idempotency (PRD Section 4 / 10.4).
   */
  sessionId: string;
  channel: SessionChannel;
  author: SessionAuthor;
  sessionWindow: SessionWindow;
  items: SessionItem[];
}

/** Per-session pipeline outcome (PRD Section 4). */
export type SessionStatus = 'ok' | 'partial' | 'error' | 'noop';

export interface PipelineLeadResult {
  localId: string;
  bitrixLeadId: number | null;
  title: string;
  warnings: string[];
}

export interface PipelineResult {
  sessionId: string;
  status: SessionStatus;
  leads: PipelineLeadResult[];
  /** Message posted back to the manager in Teams; null for `noop`. */
  replyText: string | null;
  error: string | null;
}
