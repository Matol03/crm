/**
 * Code-side business rules over raw LLM extraction (PRD Section 8).
 *
 * The model can and will be wrong, so the write-to-CRM logic never trusts it
 * blindly. This module enforces:
 *   - confidence gating ("empty beats wrong") + deterministic validators as a
 *     second gate (deviation from PRD's model-confidence-only, see decisions.md)
 *   - Partner/Customer default + independent lexical double-check
 *   - warnings for every dropped/degraded field (never silently)
 *
 * Source-priority conflict resolution (card > text > voice) is applied earlier,
 * when the segment text is assembled — see `resolveSourceConflicts`.
 */

import type {
  RawExtraction,
  GatedExtraction,
  ExtractedPhone,
  ExtractedEmail,
} from '../contracts/extraction.js';

const PARTNER_LEXICAL = [
  'partner',
  'reseller',
  'distributor',
  'resell',
  'dealer',
  'партн',
  'дистрибь',
  'реселлер',
  'дилер',
];

const EMAIL_VALID = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Digits-only length within a plausible international phone range. */
function isValidPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export interface GateOptions {
  confidenceThreshold: number;
}

/**
 * Apply confidence gating + validators + Partner double-check.
 * `sourceText` is the verbatim used for the independent Partner lexical check.
 */
export function applyGate(
  raw: RawExtraction,
  opts: GateOptions,
  sourceText: string,
): GatedExtraction {
  const warnings: string[] = [];
  const c = raw.confidence;
  const t = opts.confidenceThreshold;

  const gateScalar = (
    field: 'name' | 'company' | 'position' | 'country',
    value: string | null,
  ): string | null => {
    if (value == null || value.trim() === '') return null;
    const conf = c[field] ?? 0;
    if (conf < t) {
      warnings.push(`${field} below confidence threshold (${conf.toFixed(2)} < ${t}), left blank`);
      return null;
    }
    return value;
  };

  const name = gateScalar('name', raw.name);
  const company = gateScalar('company', raw.company);
  const position = gateScalar('position', raw.position);
  const country = gateScalar('country', raw.country);

  // Phones/emails: gate on the field-level confidence AND per-value format.
  let phones: ExtractedPhone[] = [];
  if (raw.phones.length) {
    const conf = c.phones ?? 0;
    if (conf < t) {
      warnings.push(`phones below confidence threshold (${conf.toFixed(2)} < ${t}), left blank`);
    } else {
      phones = raw.phones.filter((p) => {
        const ok = isValidPhone(p.value);
        if (!ok) warnings.push(`phone "${maskTail(p.value)}" failed format validation, dropped`);
        return ok;
      });
    }
  }

  let emails: ExtractedEmail[] = [];
  if (raw.emails.length) {
    const conf = c.emails ?? 0;
    if (conf < t) {
      warnings.push(`emails below confidence threshold (${conf.toFixed(2)} < ${t}), left blank`);
    } else {
      emails = raw.emails.filter((e) => {
        const ok = EMAIL_VALID.test(e.value);
        if (!ok) warnings.push(`email failed format validation, dropped`);
        return ok;
      });
    }
  }

  // Partner/Customer: default Customer; Partner only if the model says partner
  // AND an independent lexical marker is present in the source (Section 8).
  let leadType: 'customer' | 'partner' = 'customer';
  if (raw.leadTypeRaw === 'partner') {
    const lower = sourceText.toLowerCase();
    const markerFound = PARTNER_LEXICAL.some((m) => lower.includes(m));
    if (markerFound) {
      leadType = 'partner';
    } else {
      warnings.push('model suggested Partner but no lexical marker found; kept Customer');
    }
  }

  return {
    name,
    company,
    position,
    country,
    phones,
    emails,
    productInterestRaw: emptyToNull(raw.productInterestRaw),
    priorityRaw: emptyToNull(raw.priorityRaw),
    leadType,
    summaryRu: raw.summaryRu,
    verbatim: raw.verbatim,
    warnings,
  };
}

function emptyToNull(s: string | null): string | null {
  return s && s.trim() ? s : null;
}

/** Mask all but the last 3 chars — used only in warnings, never full PII. */
function maskTail(s: string): string {
  const tail = s.slice(-3);
  return `***${tail}`;
}

export { PARTNER_LEXICAL };
