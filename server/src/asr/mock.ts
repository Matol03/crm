/**
 * Mock ASR client (PRD Section 7 / 14).
 *
 * In mock mode, fixtures carry a pre-written transcript directly, so the whole
 * pipeline is testable with zero ASR dependency. The mock simply returns the
 * transcript that was attached to the voice item at ingestion time (passed in
 * via `bytes` decoded as UTF-8, or looked up from a provided map). A real
 * provider (e.g. Azure Speech) will implement the same `transcribe` interface.
 */

import type { AsrClient } from '../contracts/adapters.js';

export class MockAsrClient implements AsrClient {
  /** mediaUrl -> canned transcript, populated from fixtures. */
  constructor(private readonly transcripts: Map<string, string> = new Map()) {}

  register(mediaUrl: string, transcript: string): void {
    this.transcripts.set(mediaUrl, transcript);
  }

  async transcribe(audio: { mediaUrl?: string; bytes?: Uint8Array }): Promise<string> {
    if (audio.mediaUrl && this.transcripts.has(audio.mediaUrl)) {
      return this.transcripts.get(audio.mediaUrl)!;
    }
    if (audio.bytes) {
      return new TextDecoder().decode(audio.bytes);
    }
    return '';
  }
}
