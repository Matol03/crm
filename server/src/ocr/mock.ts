/**
 * Fixture OCR client (PRD Section 7; DeepSeek-has-no-vision deviation, see
 * docs/decisions.md).
 *
 * `fixture` mode returns the card text pre-supplied on the image item
 * (`ocrText`) — exactly as a real vision step would produce it — so the
 * pipeline consumes it identically whether the text came from a fixture or a
 * future Gemini vision call. Returns null for the `attachmentPending` /
 * unreadable cases so the pipeline can flag `needsAttachmentRetry`.
 */

import type { OcrClient } from '../contracts/adapters.js';

export class FixtureOcrClient implements OcrClient {
  async readCard(image: {
    mediaUrl?: string;
    bytes?: Uint8Array;
    ocrText?: string | null;
  }): Promise<string | null> {
    if (image.ocrText != null && image.ocrText !== '') return image.ocrText;
    if (image.bytes) return new TextDecoder().decode(image.bytes);
    return null;
  }
}
