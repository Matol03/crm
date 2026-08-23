/**
 * Extraction + classification + summarization contract (PRD Section 8).
 *
 * One LLM call per *segment* returns this strict shape. Business rules
 * (confidence gating, source-priority, Partner/Customer double-check) are
 * enforced in code afterwards, never left to the prompt alone.
 */

export type PhoneType = 'MOBILE' | 'WORK' | 'OTHER';
export type EmailType = 'WORK' | 'PERSONAL' | 'OTHER';
export type LeadTypeRaw = 'customer' | 'partner' | 'unclear';

export interface ExtractedPhone {
  value: string;
  type: PhoneType;
}

export interface ExtractedEmail {
  value: string;
  type: EmailType;
}

/**
 * Per-field self-reported confidence from the model (0..1). Poorly calibrated
 * on its own — see `applyConfidenceGate`, which also runs deterministic
 * validators as a second gate (deviation logged in docs/decisions.md).
 */
export interface ExtractionConfidence {
  name?: number;
  company?: number;
  position?: number;
  country?: number;
  phones?: number;
  emails?: number;
  productInterest?: number;
  priority?: number;
  leadType?: number;
}

/** Raw model output for one segment (before code-side gating). */
export interface RawExtraction {
  /** Verbatim as written/spoken, not normalized. */
  name: string | null;
  company: string | null;
  position: string | null;
  country: string | null;
  phones: ExtractedPhone[];
  emails: ExtractedEmail[];
  productInterestRaw: string | null;
  priorityRaw: string | null;
  leadTypeRaw: LeadTypeRaw;
  confidence: ExtractionConfidence;
  /** Russian-language summary, incl. the manager's evaluative judgments. */
  summaryRu: string;
  /** Full untouched text + transcript, concatenated in chronological order. */
  verbatim: string;
}

/**
 * Extraction after code-side business rules have been applied.
 * Fields that failed the confidence/validator gate are set to null here.
 */
export interface GatedExtraction {
  name: string | null;
  company: string | null;
  position: string | null;
  country: string | null;
  phones: ExtractedPhone[];
  emails: ExtractedEmail[];
  productInterestRaw: string | null;
  priorityRaw: string | null;
  /** Final classification: defaults to 'customer', 'partner' double-checked. */
  leadType: 'customer' | 'partner';
  summaryRu: string;
  verbatim: string;
  /** Human-readable notes about dropped fields, conflicts, fallbacks. */
  warnings: string[];
}

/**
 * Does this segment carry enough to be a real lead (PRD Section 6)?
 *
 * Requires at least one CONCRETE signal: a name, a phone, an email, or a
 * substantive interaction detail (productInterest / priority). The AI summary
 * is deliberately NOT a signal — it is always generated (even a generic
 * placeholder), so counting it would let pure noise through as a lead.
 */
export function isLead(e: {
  name: string | null;
  phones: ExtractedPhone[];
  emails: ExtractedEmail[];
  productInterestRaw: string | null;
  priorityRaw?: string | null;
}): boolean {
  const hasName = !!e.name && e.name.trim().length > 0;
  const hasPhone = e.phones.length > 0;
  const hasEmail = e.emails.length > 0;
  const hasSubstance =
    (!!e.productInterestRaw && e.productInterestRaw.trim().length > 0) ||
    (!!e.priorityRaw && e.priorityRaw.trim().length > 0);
  return hasName || hasPhone || hasEmail || hasSubstance;
}
