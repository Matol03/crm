/**
 * Gemini vision OCR client (PRD Section 7).
 *
 * Free-tier multimodal model reads a business-card image and returns its text as
 * `Label: value` lines, consumed identically to a fixture card. Same OcrClient
 * seam as the fixture/DeepSeek variants; short-circuits on pre-supplied text.
 * API key lives only here and is never logged.
 */

import type { OcrClient } from '../contracts/adapters.js';
import { generateContent, candidateText, modelChain } from '../llm/geminiEndpoint.js';

const OCR_PROMPT = `You are reading a business card image. Transcribe ALL visible text.
Where a field is identifiable, emit it as "Label: value" on its own line using these labels when they apply: Name, Company, Position, Country, Email, Phone.
Include every phone/email you see. Do NOT invent or normalize values. Output plain text only, no commentary.`;

export type VisionTransport = (bytes: Uint8Array, mimeType: string) => Promise<string>;

export interface GeminiOcrOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  transport?: VisionTransport;
  fetchImpl?: typeof fetch;
  fetchBytes?: (mediaUrl: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export class GeminiOcrClient implements OcrClient {
  private readonly transport: VisionTransport;

  constructor(private readonly opts: GeminiOcrOptions) {
    this.transport = opts.transport ?? defaultVisionTransport(opts);
  }

  async readCard(image: {
    mediaUrl?: string;
    bytes?: Uint8Array;
    ocrText?: string | null;
    mimeType?: string;
  }): Promise<string | null> {
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

function defaultVisionTransport(opts: GeminiOcrOptions): VisionTransport {
  const models = modelChain(opts.model);
  return async (bytes, mimeType) => {
    const json = await generateContent({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      models,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      body: {
        contents: [
          {
            parts: [
              { text: OCR_PROMPT },
              { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString('base64') } },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      },
      onFallback: (e) =>
        console.warn(JSON.stringify({ level: 'warn', src: 'gemini', code: 'model_fallback', ...e })),
    });
    return candidateText(json);
  };
}
