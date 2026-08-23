/**
 * DeepSeek vision OCR client (PRD Section 7).
 *
 * Supersedes the earlier "OCR must be a separate provider" decision (D1): the
 * account's DeepSeek API exposes a vision model (`deepseek-v4-flash-vision-exp`),
 * so card reading now uses the same provider/credential as extraction. Reads a
 * business-card image via the OpenAI-compatible chat API and returns its text as
 * `Label: value` lines. API key lives only here and is never logged.
 */

import type { OcrClient } from '../contracts/adapters.js';

const OCR_PROMPT = `You are reading a business card image. Transcribe ALL visible text.
Where a field is identifiable, emit it as "Label: value" on its own line using these labels when they apply: Name, Company, Position, Country, Email, Phone.
Include every phone/email you see. Do NOT invent or normalize values. Output plain text only, no commentary.`;

/** Injectable network layer: image bytes -> transcribed text. */
export type VisionTransport = (bytes: Uint8Array, mimeType: string) => Promise<string>;

export interface DeepSeekOcrOptions {
  apiKey: string;
  baseUrl?: string;
  /** The vision-capable model id (e.g. deepseek-v4-flash-vision-exp). */
  model?: string;
  transport?: VisionTransport;
  fetchImpl?: typeof fetch;
  /** Used to fetch bytes when only a mediaUrl is available (e.g. via Graph). */
  fetchBytes?: (mediaUrl: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export class DeepSeekOcrClient implements OcrClient {
  private readonly transport: VisionTransport;

  constructor(private readonly opts: DeepSeekOcrOptions) {
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

function defaultVisionTransport(opts: DeepSeekOcrOptions): VisionTransport {
  const baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model ?? 'deepseek-v4-flash-vision-exp';
  const doFetch = opts.fetchImpl ?? fetch;
  return async (bytes, mimeType) => {
    const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: OCR_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek vision HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? '';
  };
}
