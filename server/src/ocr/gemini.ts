/**
 * Gemini OCR client (PRD Section 7; deviation D1 — DeepSeek has no vision, so
 * card reading is a separate vision step feeding text into the extraction LLM).
 *
 * Reads a business-card image and returns its text, laid out as `Label: value`
 * lines where possible, so downstream extraction consumes it identically to a
 * fixture card. The API key lives only here and is never logged.
 */

import type { OcrClient } from '../contracts/adapters.js';

const OCR_PROMPT = `You are reading a business card image. Transcribe ALL visible text.
Where a field is identifiable, emit it as "Label: value" on its own line using these labels when they apply: Name, Company, Position, Country, Email, Phone.
Include every phone/email you see. Do NOT invent or normalize values. Output plain text only, no commentary.`;

/** Injectable network layer: image bytes -> transcribed text. */
export type GeminiVisionTransport = (bytes: Uint8Array, mimeType: string) => Promise<string>;

export interface GeminiOcrOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  transport?: GeminiVisionTransport;
  fetchImpl?: typeof fetch;
  /** Used to fetch bytes when only a mediaUrl is available (e.g. via Graph). */
  fetchBytes?: (mediaUrl: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export class GeminiOcrClient implements OcrClient {
  private readonly transport: GeminiVisionTransport;

  constructor(private readonly opts: GeminiOcrOptions) {
    this.transport = opts.transport ?? defaultVisionTransport(opts);
  }

  async readCard(image: {
    mediaUrl?: string;
    bytes?: Uint8Array;
    ocrText?: string | null;
    mimeType?: string;
  }): Promise<string | null> {
    // Pre-supplied text (e.g. a fixture) short-circuits — no vision call.
    if (image.ocrText != null && image.ocrText !== '') return image.ocrText;

    let bytes = image.bytes;
    let mimeType = image.mimeType ?? 'image/png';
    if (!bytes && image.mediaUrl && this.opts.fetchBytes) {
      const fetched = await this.opts.fetchBytes(image.mediaUrl);
      bytes = fetched.bytes;
      mimeType = fetched.mimeType;
    }
    if (!bytes || bytes.length === 0) return null;

    const text = await this.transport(bytes, mimeType);
    return text.trim() ? text.trim() : null;
  }
}

function defaultVisionTransport(opts: GeminiOcrOptions): GeminiVisionTransport {
  const baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = opts.model ?? 'gemini-2.0-flash';
  const doFetch = opts.fetchImpl ?? fetch;
  return async (bytes, mimeType) => {
    const res = await doFetch(`${baseUrl}/v1beta/models/${model}:generateContent?key=${opts.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: OCR_PROMPT },
              { inline_data: { mime_type: mimeType, data: toBase64(bytes) } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
