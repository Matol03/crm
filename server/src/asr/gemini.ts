/**
 * Gemini speech-to-text client (PRD Section 7).
 *
 * Voice notes recorded in Teams are transcribed by the same multimodal model
 * already used for extraction and card OCR, so speech needs no new provider,
 * key, or quota pool — one credential covers text, vision and audio.
 *
 * The transcript is treated as SOURCE DATA, not as an answer: it feeds the same
 * extraction and gating path as typed text, and ranks below a business card in
 * the source-priority rule (card > text > voice, Section 8). The prompt is
 * deliberately literal — a transcript that "tidies up" what the manager said
 * would corrupt the verbatim record the CRM is supposed to preserve.
 */

import type { AsrClient } from '../contracts/adapters.js';
import { fetchWithRetry } from '../llm/validate.js';

const ASR_PROMPT = `Transcribe this audio recording verbatim.
Rules:
- Write exactly what is said, in the language it is spoken. Do NOT translate.
- Do NOT summarise, correct, complete, or tidy up the speech.
- Do NOT add commentary, headings, speaker labels, or timestamps.
- Names, companies, phone numbers and e-mail addresses must be transcribed exactly as pronounced.
- If nothing intelligible is said, return an empty response.
Output the transcript text only.`;

/** Audio formats Teams voice messages arrive in, plus common fallbacks. */
const DEFAULT_MIME = 'audio/ogg';

export type AudioTransport = (bytes: Uint8Array, mimeType: string) => Promise<string>;

export interface GeminiAsrOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  transport?: AudioTransport;
  fetchImpl?: typeof fetch;
  /** Resolve a media URL to bytes when the caller could not. */
  fetchBytes?: (mediaUrl: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export class GeminiAsrClient implements AsrClient {
  private readonly transport: AudioTransport;

  constructor(private readonly opts: GeminiAsrOptions) {
    this.transport = opts.transport ?? defaultAudioTransport(opts);
  }

  async transcribe(audio: {
    mediaUrl?: string;
    bytes?: Uint8Array;
    mimeType?: string;
  }): Promise<string> {
    let bytes = audio.bytes;
    let mimeType = audio.mimeType ?? DEFAULT_MIME;

    if (!bytes && audio.mediaUrl && this.opts.fetchBytes) {
      const fetched = await this.opts.fetchBytes(audio.mediaUrl);
      bytes = fetched.bytes;
      mimeType = fetched.mimeType;
    }
    // No audio to work with: return empty rather than throwing, so one
    // unreadable note never fails the whole session.
    if (!bytes || bytes.length === 0) return '';

    const text = await this.transport(bytes, normaliseMime(mimeType));
    return text.trim();
  }
}

/**
 * Teams reports voice notes with container types the API does not always
 * accept verbatim (e.g. `audio/ogg; codecs=opus`). Strip parameters and map the
 * few known aliases; anything unrecognised is passed through unchanged.
 */
export function normaliseMime(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  const alias: Record<string, string> = {
    'audio/x-wav': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/mpeg3': 'audio/mp3',
    'audio/x-m4a': 'audio/mp4',
    'audio/webm': 'audio/ogg',
  };
  return alias[base] ?? (base.startsWith('audio/') ? base : DEFAULT_MIME);
}

function defaultAudioTransport(opts: GeminiAsrOptions): AudioTransport {
  const baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = opts.model ?? 'gemini-2.5-flash';
  const doFetch = opts.fetchImpl ?? fetch;

  return async (bytes, mimeType) => {
    const res = await fetchWithRetry(
      doFetch,
      `${baseUrl}/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: ASR_PROMPT },
                { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString('base64') } },
              ],
            },
          ],
          // Zero temperature: a transcript must be reproducible, not creative.
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini audio HTTP ${res.status}`);
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  };
}
