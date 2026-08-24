/**
 * Field provenance: linking each extracted value back to the exact source
 * message it came from (PRD Section 7).
 *
 * This is resolved in CODE, not asked of the model, because attribution is a
 * lookup rather than a judgement: the value (or the model's own quote for it)
 * either appears in a given message or it does not. That makes the link
 * verifiable and impossible to hallucinate.
 *
 * Resolution order per field:
 *   1. the model's `evidence` quote, located in a message      -> 'quote'
 *   2. the extracted value itself, located in a message        -> 'value'
 *   3. nothing matched                                         -> 'inferred'
 *
 * When several messages contain the same text, the PRD's source priority wins:
 * business card > typed text > voice transcript (Section 8).
 */

import type { SessionItem } from '../contracts/session.js';
import type { GatedExtraction, FieldProvenance } from '../contracts/extraction.js';

/** Card beats typed text beats voice, per Section 8's conflict rule. */
const SOURCE_RANK: Record<string, number> = { image: 3, text: 2, voice: 1 };

/** All searchable text of a message, lower-cased for comparison. */
function haystack(item: SessionItem): string {
  return [item.text, item.transcript, item.ocrText]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

/** Comparable form: lower-case, collapse whitespace, drop punctuation noise. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Digits only — lets a phone match across different formatting. */
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Find the best message containing `needle`.
 * Returns null when no message contains it.
 */
function locate(items: SessionItem[], needle: string, { isPhone = false } = {}): SessionItem | null {
  const target = isPhone ? digits(needle) : normalise(needle);
  if (target.length < (isPhone ? 5 : 2)) return null;

  const hits = items.filter((item) => {
    const hay = haystack(item);
    return isPhone ? digits(hay).includes(target) : hay.includes(target);
  });
  if (!hits.length) return null;

  // Highest source rank wins; ties break on the earliest message.
  return hits.sort((a, b) =>
    (SOURCE_RANK[b.type] ?? 0) - (SOURCE_RANK[a.type] ?? 0) ||
    Date.parse(a.timestamp) - Date.parse(b.timestamp))[0]!;
}

/** The value each provenance-tracked field holds after gating. */
function fieldValues(gated: GatedExtraction): Array<[string, string | null, boolean]> {
  const first = (arr: Array<{ value: string }>) => (arr.length ? arr[0]!.value : null);
  return [
    ['name', gated.name, false],
    ['company', gated.company, false],
    ['position', gated.position, false],
    ['country', gated.country, false],
    ['phone', first(gated.phones), true],
    ['email', first(gated.emails), false],
    ['productInterest', gated.productInterestRaw, false],
    ['priority', gated.priorityRaw, false],
  ];
}

/**
 * Build the field -> source-message map for one segment.
 *
 * @param items    the segment's source messages
 * @param gated    the values actually written to the CRM
 * @param evidence optional per-field quotes returned by the model
 */
export function resolveProvenance(
  items: SessionItem[],
  gated: GatedExtraction,
  evidence: Record<string, string> = {},
): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {};

  for (const [field, value, isPhone] of fieldValues(gated)) {
    if (value == null || value === '') continue;

    // 1. Prefer the model's own quote — it carries the surrounding context
    //    that explains *why* the value was read that way.
    const quote = evidence[field];
    if (quote && quote.trim()) {
      const byQuote = locate(items, quote);
      if (byQuote) {
        out[field] = { messageId: byQuote.messageId, quote: quote.trim(), method: 'quote' };
        continue;
      }
    }

    // 2. Fall back to locating the value itself.
    const byValue = locate(items, value, { isPhone });
    if (byValue) {
      out[field] = { messageId: byValue.messageId, quote: value, method: 'value' };
      continue;
    }

    // 3. Nothing matched — say so rather than attributing it to a message.
    out[field] = {
      messageId: null,
      quote: quote?.trim() || null,
      method: 'inferred',
    };
  }

  return out;
}
