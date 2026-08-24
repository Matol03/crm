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
  /**
   * Short verbatim quote the model read each value from, keyed by field.
   * Used to resolve provenance back to a specific source message; optional
   * because a value may be inferred rather than quoted.
   */
  evidence?: Record<string, string>;
  /** Russian-language summary, incl. the manager's evaluative judgments. */
  summaryRu: string;
  /** Full untouched text + transcript, concatenated in chronological order. */
  verbatim: string;
}

/**
 * Where a single extracted value came from.
 *
 * `method` records how the link was established, so the UI can distinguish a
 * value quoted verbatim from one the model inferred:
 *   'quote'   — the model's own quote was located in that message
 *   'value'   — the extracted value itself was found in that message
 *   'inferred'— no source text matched; no message is claimed
 */
export interface FieldProvenance {
  messageId: string | null;
  quote: string | null;
  method: 'quote' | 'value' | 'inferred';
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
  /**
   * Per-field confidence carried through from the model. Retained (rather than
   * consumed and discarded by the gate) so the operator UI can show how sure
   * the system was about each value it wrote.
   */
  confidence: ExtractionConfidence;
  /** Field -> the source message and quote it was read from. */
  provenance: Record<string, FieldProvenance>;
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
