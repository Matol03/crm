/**
 * Adapter interfaces — the seams that keep ingestion/ASR/OCR/LLM/Bitrix
 * provider choices out of the pipeline (PRD Sections 4, 7, 8, 10).
 *
 * Every external system sits behind one of these. Mock impls satisfy them for
 * zero-dependency development and testing; real impls are swapped in later
 * without touching grouping/extraction/mapping.
 */

import type { SessionItem, AttachmentRef } from './session.js';
import type { RawExtraction } from './extraction.js';
import type { SegmentationResult } from './segmentation.js';

/** Raw message as it comes off Microsoft Graph, before bundling. */
export interface RawChannelMessage {
  messageId: string;
  timestamp: string;
  author: { teamsUserId: string; email: string; displayName: string };
  channel: { teamsGroupId: string; channelId: string };
  /** Thread root id when this is a reply; undefined for a top-level message. */
  replyToId?: string;
  items: SessionItem[];
}

/** Ingestion: get new channel messages since a watermark (PRD Section 4). */
export interface MsGraphClient {
  getNewChannelMessages(since: string): Promise<RawChannelMessage[]>;
  /**
   * Download an attachment's bytes. Returns null when the file is not (yet)
   * retrievable — the caller then flags the lead for retry rather than failing.
   */
  fetchAttachment(ref: AttachmentRef): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /** Post the manager reply back into the Teams thread (PRD Section 11). */
  postReply(
    channel: { teamsGroupId: string; channelId: string },
    threadId: string | null,
    text: string,
  ): Promise<void>;
}

/** ASR: speech-to-text behind an adapter (PRD Section 7). */
export interface AsrClient {
  transcribe(audio: { mediaUrl?: string; bytes?: Uint8Array }): Promise<string>;
}

/**
 * OCR: business-card image -> text. In the PRD this was folded into the LLM
 * vision call, but DeepSeek has no vision input, so OCR is its own adapter
 * (see docs/decisions.md). `fixture` mode returns pre-supplied card text.
 */
export interface OcrClient {
  readCard(image: {
    mediaUrl?: string;
    bytes?: Uint8Array;
    ocrText?: string | null;
    mimeType?: string;
  }): Promise<string | null>;
}

/** LLM: segmentation + extraction (PRD Sections 6, 8). */
export interface LlmClient {
  segment(input: {
    items: Array<Pick<SessionItem, 'messageId' | 'timestamp' | 'type' | 'text' | 'transcript' | 'ocrText'>>;
  }): Promise<SegmentationResult>;

  extract(input: {
    /** All resolved text for the segment, chronological. */
    segmentText: string;
    /** Card text (from OCR) kept separate so the model can reconcile sources. */
    cardText: string | null;
  }): Promise<RawExtraction>;
}
