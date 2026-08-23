/**
 * DeepSeek LLM client (PRD Sections 6, 8) — OpenAI-compatible chat completions.
 *
 * Implements segmentation + extraction behind the LlmClient adapter. Enforces
 * strict JSON with up to 2 retries on malformed output (S8); on a third failure
 * `extract` throws so the pipeline marks the segment failed with verbatim
 * preserved. The API key lives only here and is never logged.
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
  parseJsonLoose,
  validateSegmentation,
  validateExtraction,
  completeJson,
  type SegItem,
  type ChatMessage,
  type ChatTransport,
} from './validate.js';

export { parseJsonLoose };
export type { ChatMessage, ChatTransport };

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxJsonRetries?: number;
  /** Override the network layer (default: real fetch to DeepSeek). */
  transport?: ChatTransport;
  fetchImpl?: typeof fetch;
}

export class DeepSeekLlmClient implements LlmClient {
  private readonly transport: ChatTransport;
  private readonly maxJsonRetries: number;

  constructor(opts: DeepSeekOptions) {
    this.maxJsonRetries = opts.maxJsonRetries ?? 2;
    this.transport = opts.transport ?? defaultTransport(opts);
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

// ── network default ──────────────────────────────────────────

function defaultTransport(opts: DeepSeekOptions): ChatTransport {
  const baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model ?? 'deepseek-v4-flash';
  const doFetch = opts.fetchImpl ?? fetch;
  return async (messages) => {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? '';
  };
}
