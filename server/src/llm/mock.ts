/**
 * Deterministic heuristic LLM mock (PRD Sections 6, 8).
 *
 * Implements the LlmClient adapter without any network call, so the whole
 * pipeline is testable offline. It does *real* (if simple) work — regex comm
 * extraction, structured-card parsing, marker-based segmentation — rather than
 * echoing ground truth, so tests exercise genuine pipeline mechanics. A real
 * DeepSeek-backed client will replace this behind the same interface.
 */

import type { LlmClient } from '../contracts/adapters.js';
import type { SessionItem } from '../contracts/session.js';
import type {
  RawExtraction,
  ExtractedPhone,
  ExtractedEmail,
  LeadTypeRaw,
} from '../contracts/extraction.js';
import type { SegmentationResult } from '../contracts/segmentation.js';

const SEGMENT_MARKERS = [
  'second contact',
  'third contact',
  'next contact',
  'one more',
  'another contact',
  'второй контакт',
  'третий контакт',
  'следующий контакт',
  'ещё один',
  'еще один',
  'другой контакт',
];

// Intent-bearing markers only (mirrors extraction/gating PARTNER_LEXICAL) — the
// bare noun "partner" over-triggers on incidental phrasing like "partner booth".
const PARTNER_MARKERS = [
  'reseller',
  'resell',
  'distributor',
  'want to resell',
  'become a partner',
  'partnership',
  'дистрибь',
  'реселлер',
  'дилер',
  'партнёрств',
  'партнерств',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// International-ish phone: optional +, groups of digits/spaces/dashes/parens, >=7 digits.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

type SegItem = Pick<SessionItem, 'messageId' | 'timestamp' | 'type' | 'text' | 'transcript' | 'ocrText'>;

function itemText(i: SegItem): string {
  return [i.text, i.transcript, i.ocrText].filter(Boolean).join(' ').toLowerCase();
}

export class HeuristicLlmClient implements LlmClient {
  async segment(input: { items: SegItem[] }): Promise<SegmentationResult> {
    const segments: Array<{ segmentId: string; messageIds: string[]; rationale?: string }> = [];
    let current: string[] = [];
    let currentHasImage = false;
    let rationale = '';

    const flush = () => {
      if (current.length) {
        segments.push({
          segmentId: `seg-${segments.length + 1}`,
          messageIds: current,
          ...(rationale ? { rationale } : {}),
        });
      }
      current = [];
      currentHasImage = false;
      rationale = '';
    };

    for (const item of input.items) {
      const text = itemText(item);
      const hasMarker = SEGMENT_MARKERS.some((m) => text.includes(m));
      const isNewCardBoundary = item.type === 'image' && currentHasImage;

      if ((hasMarker || isNewCardBoundary) && current.length) {
        flush();
        rationale = hasMarker ? 'explicit separator phrase' : 'new business card, no follow-up language';
      }
      current.push(item.messageId);
      if (item.type === 'image') currentHasImage = true;
    }
    flush();

    if (segments.length === 0) segments.push({ segmentId: 'seg-1', messageIds: [] });
    return { segments };
  }

  async extract(input: { segmentText: string; cardText: string | null }): Promise<RawExtraction> {
    const card = input.cardText ?? '';
    const combined = `${card}\n${input.segmentText}`.trim();
    const lower = combined.toLowerCase();

    // Comm channels via regex (high confidence — pattern-verified).
    const emails: ExtractedEmail[] = dedupe(match(combined, EMAIL_RE)).map((value) => ({
      value,
      type: /gmail|yahoo|outlook|hotmail|mail\.ru/i.test(value) ? 'PERSONAL' : 'WORK',
    }));
    const phones: ExtractedPhone[] = dedupe(match(combined, PHONE_RE).map(normalizePhone))
      .filter((p) => p.replace(/\D/g, '').length >= 7)
      .map((value, idx) => ({ value, type: idx === 0 ? 'MOBILE' : 'WORK' }));

    // Structured card fields ("Label: value"), then free-text fallbacks.
    const name = field(card, ['name', 'имя', 'фио']) ?? guessName(input.segmentText);
    const company = field(card, ['company', 'компания', 'организация']);
    const position = field(card, ['position', 'title', 'должность', 'позиция']);
    const country = field(card, ['country', 'страна']);

    // Partner double-check happens in code; mock reports what it lexically sees.
    const leadTypeRaw: LeadTypeRaw = PARTNER_MARKERS.some((m) => lower.includes(m))
      ? 'partner'
      : 'unclear';

    const productInterestRaw = extractInterest(lower);
    const priorityRaw = extractPriority(lower);

    const summaryRu = buildSummaryRu({ position, company, productInterestRaw, priorityRaw });

    return {
      name,
      company,
      position,
      country,
      phones,
      emails,
      productInterestRaw,
      priorityRaw,
      leadTypeRaw,
      confidence: {
        name: name ? (field(card, ['name', 'имя', 'фио']) ? 0.9 : 0.5) : 0,
        company: company ? 0.9 : 0,
        position: position ? 0.9 : 0,
        country: country ? 0.9 : 0,
        phones: phones.length ? 0.9 : 0,
        emails: emails.length ? 0.9 : 0,
        productInterest: productInterestRaw ? 0.8 : 0,
        priority: priorityRaw ? 0.8 : 0,
        leadType: leadTypeRaw === 'partner' ? 0.8 : 0.5,
      },
      summaryRu,
      verbatim: input.segmentText,
    };
  }
}

// ── helpers ──────────────────────────────────────────────────

function match(text: string, re: RegExp): string[] {
  return text.match(re) ?? [];
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()))].filter(Boolean);
}

function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return plus ? `+${digits}` : digits;
}

/** Parse a "Label: value" line from card text (case-insensitive labels). */
function field(card: string, labels: string[]): string | null {
  for (const line of card.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.+)\s*$/);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    if (labels.includes(key)) {
      const val = m[2]!.trim();
      if (val) return val;
    }
  }
  return null;
}

function guessName(_segmentText: string): string | null {
  // Free-text name inference is deliberately conservative in the mock.
  return null;
}

function extractInterest(lower: string): string | null {
  const keys = [
    'analytics',
    'integration',
    'platform',
    'support',
    'training',
    'oem',
    'white label',
    'аналитик',
    'интеграц',
    'платформ',
    'поддержк',
    'обучен',
  ];
  const hit = keys.find((k) => lower.includes(k));
  return hit ? snippetAround(lower, hit) : null;
}

function extractPriority(lower: string): string | null {
  if (/(urgent|срочно|asap|высок|high priority|call back|перезвон)/.test(lower)) return 'urgent';
  if (/(low priority|не срочно|низк)/.test(lower)) return 'low';
  if (/(medium|средн)/.test(lower)) return 'medium';
  return null;
}

function snippetAround(text: string, key: string): string {
  const idx = text.indexOf(key);
  return text.slice(Math.max(0, idx - 10), idx + key.length + 20).trim();
}

function buildSummaryRu(p: {
  position: string | null;
  company: string | null;
  productInterestRaw: string | null;
  priorityRaw: string | null;
}): string {
  const parts: string[] = [];
  const who = [p.position, p.company].filter(Boolean).join(' ');
  if (who) parts.push(`${who}`);
  if (p.productInterestRaw) parts.push(`интересуется: ${p.productInterestRaw}`);
  if (p.priorityRaw) parts.push(`приоритет: ${p.priorityRaw}`);
  return parts.length ? parts.join('; ') + '.' : 'Контакт с выставки.';
}
