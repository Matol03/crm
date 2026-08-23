/**
 * DeepSeek LLM client (PRD Sections 6, 8) — OpenAI-compatible chat completions.
 *
 * Implements segmentation + extraction behind the LlmClient adapter. Enforces
 * strict JSON with up to 2 retries on malformed output (S8); on a third failure
 * `extract` throws so the pipeline marks the segment failed with verbatim
 * preserved. The API key lives only here and is never logged.
 */

import type { LlmClient } from '../contracts/adapters.js';
import type { SessionItem } from '../contracts/session.js';
import type { RawExtraction, LeadTypeRaw, ExtractionConfidence } from '../contracts/extraction.js';
import type { SegmentationResult } from '../contracts/segmentation.js';
import {
  SEGMENTATION_SYSTEM,
  segmentationUser,
  EXTRACTION_SYSTEM,
  extractionUser,
} from './prompts.js';

type SegItem = Pick<SessionItem, 'messageId' | 'timestamp' | 'type' | 'text' | 'transcript' | 'ocrText'>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Injectable so tests stub the network entirely. Returns assistant content. */
export type ChatTransport = (messages: ChatMessage[]) => Promise<string>;

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
    const parsed = await this.completeJson(messages, (obj) => validateSegmentation(obj, input.items));
    return parsed;
  }

  async extract(input: { segmentText: string; cardText: string | null }): Promise<RawExtraction> {
    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM },
      { role: 'user', content: extractionUser(input.segmentText, input.cardText) },
    ];
    return this.completeJson(messages, (obj) => validateExtraction(obj, input));
  }

  /** Call the model, parse+validate JSON, retry on malformed up to the limit. */
  private async completeJson<T>(messages: ChatMessage[], validate: (obj: unknown) => T): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxJsonRetries; attempt++) {
      const raw = await this.transport(messages);
      try {
        return validate(parseJsonLoose(raw));
      } catch (e) {
        lastErr = e;
        // Nudge the model on retry.
        messages = [
          ...messages,
          { role: 'assistant', content: raw.slice(0, 2000) },
          { role: 'user', content: 'That was not valid JSON matching the required shape. Return ONLY the corrected strict JSON.' },
        ];
      }
    }
    throw new Error(`DeepSeek returned invalid JSON after ${this.maxJsonRetries + 1} attempts: ${String(lastErr)}`);
  }
}

// ── network default ──────────────────────────────────────────

function defaultTransport(opts: DeepSeekOptions): ChatTransport {
  const baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model ?? 'deepseek-chat';
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

// ── parsing + validation ─────────────────────────────────────

/** Tolerate code fences / stray prose around the JSON object. */
export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('no JSON object found');
  }
}

function validateSegmentation(obj: unknown, items: SegItem[]): SegmentationResult {
  const o = obj as { segments?: unknown };
  if (!o || !Array.isArray(o.segments)) throw new Error('missing segments[]');
  const known = new Set(items.map((i) => i.messageId));
  const segments = o.segments.map((s, idx) => {
    const seg = s as { segmentId?: unknown; messageIds?: unknown; rationale?: unknown };
    if (!Array.isArray(seg.messageIds)) throw new Error('segment.messageIds must be an array');
    const ids = seg.messageIds.map(String).filter((id) => known.has(id));
    return {
      segmentId: typeof seg.segmentId === 'string' ? seg.segmentId : `seg-${idx + 1}`,
      messageIds: ids,
      ...(typeof seg.rationale === 'string' ? { rationale: seg.rationale } : {}),
    };
  });
  // Guard: every message must be assigned somewhere; if the model dropped some,
  // append a catch-all segment so no input is silently lost.
  const assigned = new Set(segments.flatMap((s) => s.messageIds));
  const missing = items.map((i) => i.messageId).filter((id) => !assigned.has(id));
  if (missing.length) segments.push({ segmentId: `seg-${segments.length + 1}`, messageIds: missing });
  return { segments: segments.filter((s) => s.messageIds.length > 0) };
}

function asType<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function validateExtraction(obj: unknown, input: { segmentText: string; cardText: string | null }): RawExtraction {
  if (!obj || typeof obj !== 'object') throw new Error('extraction is not an object');
  const o = obj as Record<string, unknown>;
  const phones = Array.isArray(o.phones)
    ? (o.phones as Array<Record<string, unknown>>).map((p) => ({
        value: String(p.value ?? ''),
        type: asType(p.type, ['MOBILE', 'WORK', 'OTHER'] as const, 'OTHER'),
      })).filter((p) => p.value)
    : [];
  const emails = Array.isArray(o.emails)
    ? (o.emails as Array<Record<string, unknown>>).map((e) => ({
        value: String(e.value ?? ''),
        type: asType(e.type, ['WORK', 'PERSONAL', 'OTHER'] as const, 'OTHER'),
      })).filter((e) => e.value)
    : [];
  const conf = (o.confidence ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);

  if (typeof o.summaryRu !== 'string') throw new Error('summaryRu missing');

  const leadTypeRaw: LeadTypeRaw = asType(o.leadTypeRaw, ['customer', 'partner', 'unclear'] as const, 'unclear');

  const confidence: ExtractionConfidence = {};
  const setC = (k: keyof ExtractionConfidence, v: unknown): void => {
    const n = num(v);
    if (n !== undefined) confidence[k] = n;
  };
  setC('name', conf.name);
  setC('company', conf.company);
  setC('position', conf.position);
  setC('country', conf.country);
  setC('phones', conf.phones);
  setC('emails', conf.emails);
  setC('productInterest', conf.productInterest);
  setC('priority', conf.priority);
  setC('leadType', conf.leadType);

  return {
    name: strOrNull(o.name),
    company: strOrNull(o.company),
    position: strOrNull(o.position),
    country: strOrNull(o.country),
    phones,
    emails,
    productInterestRaw: strOrNull(o.productInterestRaw),
    priorityRaw: strOrNull(o.priorityRaw),
    leadTypeRaw,
    confidence,
    summaryRu: o.summaryRu,
    verbatim: typeof o.verbatim === 'string' && o.verbatim.trim()
      ? o.verbatim
      : [input.cardText, input.segmentText].filter(Boolean).join('\n'),
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
