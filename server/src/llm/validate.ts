/**
 * Shared LLM output parsing + validation (PRD Sections 6, 8).
 *
 * Provider-agnostic: both the DeepSeek and Gemini clients coerce raw model JSON
 * into the strict contract shapes through these functions, so the business
 * rules (unknown-id filtering, catch-all segment, confidence coercion, verbatim
 * fallback) live in one place regardless of provider.
 */

import type { RawExtraction, LeadTypeRaw, ExtractionConfidence } from '../contracts/extraction.js';
import type { SegmentationResult } from '../contracts/segmentation.js';
import type { SessionItem } from '../contracts/session.js';

export type SegItem = Pick<SessionItem, 'messageId' | 'timestamp' | 'type' | 'text' | 'transcript' | 'ocrText'>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Injectable network layer shared by text LLM clients. Returns assistant text. */
export type ChatTransport = (messages: ChatMessage[]) => Promise<string>;

/**
 * Call the model, parse+validate JSON, retry on malformed up to the limit
 * (PRD S8: <=2 retries then fail). Provider-agnostic — the transport hides the
 * HTTP shape.
 */
export async function completeJson<T>(
  transport: ChatTransport,
  messages: ChatMessage[],
  validate: (obj: unknown) => T,
  maxJsonRetries: number,
): Promise<T> {
  let msgs = messages;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxJsonRetries; attempt++) {
    const raw = await transport(msgs);
    try {
      return validate(parseJsonLoose(raw));
    } catch (e) {
      lastErr = e;
      msgs = [
        ...msgs,
        { role: 'assistant', content: raw.slice(0, 2000) },
        { role: 'user', content: 'That was not valid JSON matching the required shape. Return ONLY the corrected strict JSON.' },
      ];
    }
  }
  throw new Error(`LLM returned invalid JSON after ${maxJsonRetries + 1} attempts: ${String(lastErr)}`);
}

/**
 * Retry an HTTP call on transient provider failures (PRD S8 robustness).
 *
 * 429 (rate limited) and 5xx (overloaded/unavailable) are transient and common
 * on shared/free LLM endpoints — a single 503 must not cost a lead when the
 * service runs unattended. Non-transient statuses return immediately so real
 * errors surface fast. Note: an exhausted DAILY quota also returns 429 and will
 * still fail after the retries, by design — no amount of backoff fixes it.
 */
export async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await doFetch(url, init);
    if (res.ok) return res;
    const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!transient || attempt === maxRetries) return res;
    // Honor Retry-After when the provider supplies it.
    const retryAfter = Number(res.headers?.get?.('retry-after') ?? '');
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : baseDelayMs * 2 ** attempt;
    last = res;
    await sleep(waitMs);
  }
  return last as Response;
}

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

export function validateSegmentation(obj: unknown, items: SegItem[]): SegmentationResult {
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
  // Guard: every message must be assigned; append a catch-all for any the model
  // dropped so no input is silently lost.
  const assigned = new Set(segments.flatMap((s) => s.messageIds));
  const missing = items.map((i) => i.messageId).filter((id) => !assigned.has(id));
  if (missing.length) segments.push({ segmentId: `seg-${segments.length + 1}`, messageIds: missing });
  return { segments: segments.filter((s) => s.messageIds.length > 0) };
}

function asType<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export function validateExtraction(
  obj: unknown,
  input: { segmentText: string; cardText: string | null },
): RawExtraction {
  if (!obj || typeof obj !== 'object') throw new Error('extraction is not an object');
  const o = obj as Record<string, unknown>;
  const phones = Array.isArray(o.phones)
    ? (o.phones as Array<Record<string, unknown>>)
        .map((p) => ({ value: String(p.value ?? ''), type: asType(p.type, ['MOBILE', 'WORK', 'OTHER'] as const, 'OTHER') }))
        .filter((p) => p.value)
    : [];
  const emails = Array.isArray(o.emails)
    ? (o.emails as Array<Record<string, unknown>>)
        .map((e) => ({ value: String(e.value ?? ''), type: asType(e.type, ['WORK', 'PERSONAL', 'OTHER'] as const, 'OTHER') }))
        .filter((e) => e.value)
    : [];
  const conf = (o.confidence ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);

  // summaryRu is a nice-to-have, not a hard requirement — a bare card may have
  // nothing to summarize. Default to empty rather than failing the whole lead.
  const summaryRu = typeof o.summaryRu === 'string' ? o.summaryRu : '';

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

  // Per-field quotes: keep only string values, trimmed.
  const evidence: Record<string, string> = {};
  if (o.evidence && typeof o.evidence === 'object') {
    for (const [k, v] of Object.entries(o.evidence as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) evidence[k] = v.trim();
    }
  }

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
    ...(Object.keys(evidence).length ? { evidence } : {}),
    summaryRu,
    verbatim:
      typeof o.verbatim === 'string' && o.verbatim.trim()
        ? o.verbatim
        : [input.cardText, input.segmentText].filter(Boolean).join('\n'),
  };
}
