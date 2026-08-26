/**
 * Gemini LLM client (PRD Sections 6, 8) — free-tier text model via the
 * generativelanguage API. Implements segmentation + extraction behind the
 * LlmClient adapter, sharing the same JSON validators and <=2-retry flow as the
 * DeepSeek client (only the HTTP shape differs). API key never logged.
 */

import type { LlmClient } from '../contracts/adapters.js';
import type { RawExtraction } from '../contracts/extraction.js';
import type { SegmentationResult } from '../contracts/segmentation.js';
import {
  SEGMENTATION_SYSTEM,
  segmentationUser,
  EXTRACTION_SYSTEM,
  extractionUser,
} from './prompts.js';
import {
  validateSegmentation,
  validateExtraction,
  completeJson,
  fetchWithRetry,
  type SegItem,
  type ChatMessage,
  type ChatTransport,
} from './validate.js';

export interface GeminiLlmOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxJsonRetries?: number;
  transport?: ChatTransport;
  fetchImpl?: typeof fetch;
}

export class GeminiLlmClient implements LlmClient {
  private readonly transport: ChatTransport;
  private readonly maxJsonRetries: number;

  constructor(opts: GeminiLlmOptions) {
    this.maxJsonRetries = opts.maxJsonRetries ?? 2;
    this.transport = opts.transport ?? defaultGeminiTransport(opts);
  }

  async segment(input: { items: SegItem[] }): Promise<SegmentationResult> {
    if (input.items.length === 0) return { segments: [{ segmentId: 'seg-1', messageIds: [] }] };
    const messages: ChatMessage[] = [
      { role: 'system', content: SEGMENTATION_SYSTEM },
      { role: 'user', content: segmentationUser(input.items) },
    ];
    return completeJson(this.transport, messages, (obj) => validateSegmentation(obj, input.items), this.maxJsonRetries);
  }

  async extract(input: { segmentText: string; cardText: string | null }): Promise<RawExtraction> {
    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM },
      { role: 'user', content: extractionUser(input.segmentText, input.cardText) },
    ];
    return completeJson(this.transport, messages, (obj) => validateExtraction(obj, input), this.maxJsonRetries);
  }
}

/**
 * Map the provider-agnostic ChatMessage[] onto Gemini's request shape:
 * system messages -> systemInstruction; user/assistant -> contents (user/model).
 * JSON mode via responseMimeType so the model returns a bare JSON object.
 */
function defaultGeminiTransport(opts: GeminiLlmOptions): ChatTransport {
  const baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = opts.model ?? 'gemini-3.6-flash';
  const doFetch = opts.fetchImpl ?? fetch;
  return async (messages) => {
    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

    const res = await fetchWithRetry(doFetch, `${baseUrl}/v1beta/models/${model}:generateContent?key=${opts.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  };
}
