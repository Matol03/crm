/**
 * Accuracy scoring against the synthetic ground truth (PRD Section 15).
 *
 * Pure functions over (groundTruth, createdLeads) so scoring is unit-testable
 * and independent of how the leads were produced. Metrics mirror the charter:
 *   - lead-count accuracy (± tolerance on genuinely ambiguous sessions)
 *   - field-level precision (fraction of POPULATED fields that are correct; an
 *     intentionally-blank field is never counted as an error)
 *   - cross-contamination rate (headline: a lead carrying a fact that belongs to
 *     a different contact) — should be ~0
 *   - Partner precision/recall (asymmetric-cost classes, S8)
 *   - non-lead false-positive / false-negative on the noise cases
 *
 * Caveat (S14): the fixtures are self-authored, so these are self-consistency
 * checks on pipeline mechanics, not independent extraction validation.
 */

export interface GtLead {
  name?: string;
  company?: string;
  leadType?: 'customer' | 'partner';
  hasEmail?: boolean;
  hasPhone?: boolean;
}

export interface GtSession {
  name: string;
  sessionId: string;
  expectedLeadCount: number;
  isNonLead: boolean;
  leads: GtLead[];
}

export interface GroundTruth {
  sessions: GtSession[];
}

/** A lead as produced by the pipeline (read back from the DB). */
export interface ScoredLead {
  sessionId: string;
  name: string | null;
  company: string | null;
  emails: string[];
  phones: string[];
  leadType: 'customer' | 'partner';
}

export interface MetricsReport {
  leadCount: { correct: number; withinTolerance: number; total: number };
  fieldPrecision: { correct: number; populated: number; precision: number };
  crossContamination: { contaminated: number; total: number; rate: number };
  partner: { tp: number; fp: number; fn: number; precision: number; recall: number };
  nonLead: { falsePositives: number; falseNegatives: number };
  totalCreated: number;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/** Loose equality: exact (case-insensitive) or one contains the other. */
function loosely(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export function scoreBatch(
  gt: GroundTruth,
  created: ScoredLead[],
  tolerance = 1,
): MetricsReport {
  const bySession = new Map<string, ScoredLead[]>();
  for (const lead of created) {
    const arr = bySession.get(lead.sessionId) ?? [];
    arr.push(lead);
    bySession.set(lead.sessionId, arr);
  }

  // ── lead-count + non-lead FP/FN ──
  let countCorrect = 0;
  let countWithinTol = 0;
  let nonLeadFP = 0;
  let nonLeadFN = 0;
  for (const s of gt.sessions) {
    const got = (bySession.get(s.sessionId) ?? []).length;
    if (got === s.expectedLeadCount) countCorrect++;
    if (Math.abs(got - s.expectedLeadCount) <= tolerance) countWithinTol++;
    if (s.isNonLead && got > 0) nonLeadFP++;
    if (!s.isNonLead && s.expectedLeadCount > 0 && got === 0) nonLeadFN++;
  }

  // ── field precision + Partner P/R (over matched pairs) ──
  let fieldCorrect = 0;
  let fieldPopulated = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of gt.sessions) {
    const gotLeads = bySession.get(s.sessionId) ?? [];
    const pairs = matchLeads(s.leads, gotLeads);
    for (const { expected, actual } of pairs) {
      if (!actual) continue;
      // field precision
      if (expected?.name && actual.name) {
        fieldPopulated++;
        if (loosely(actual.name, expected.name)) fieldCorrect++;
      }
      if (expected?.company && actual.company) {
        fieldPopulated++;
        if (loosely(actual.company, expected.company)) fieldCorrect++;
      }
      if (expected?.hasEmail !== undefined && actual.emails.length > 0) {
        fieldPopulated++;
        if (expected.hasEmail) fieldCorrect++;
      }
      if (expected?.hasPhone !== undefined && actual.phones.length > 0) {
        fieldPopulated++;
        if (expected.hasPhone) fieldCorrect++;
      }
      // Partner P/R
      const expPartner = expected?.leadType === 'partner';
      const actPartner = actual.leadType === 'partner';
      if (expPartner && actPartner) tp++;
      else if (!expPartner && actPartner) fp++;
      else if (expPartner && !actPartner) fn++;
    }
  }

  // ── cross-contamination ──
  // An entity (name/company/email) is "owned" by the sessions whose ground
  // truth legitimately expects it. A created lead is contaminated if it carries
  // an entity owned ONLY by other sessions.
  const ownersOf = new Map<string, Set<string>>();
  const addOwner = (token: string, sessionId: string) => {
    const key = norm(token);
    if (!key) return;
    const set = ownersOf.get(key) ?? new Set<string>();
    set.add(sessionId);
    ownersOf.set(key, set);
  };
  for (const s of gt.sessions) {
    for (const l of s.leads) {
      if (l.name) addOwner(l.name, s.sessionId);
      if (l.company) addOwner(l.company, s.sessionId);
    }
  }
  let contaminated = 0;
  for (const lead of created) {
    const tokens = [lead.name, lead.company].filter(Boolean) as string[];
    let bad = false;
    for (const tok of tokens) {
      const owners = ownersOf.get(norm(tok));
      // Only judge tokens the ground truth actually tracks.
      if (owners && owners.size > 0 && !owners.has(lead.sessionId)) bad = true;
    }
    if (bad) contaminated++;
  }

  const precision = fieldPopulated ? fieldCorrect / fieldPopulated : 1;
  const partnerPrecision = tp + fp ? tp / (tp + fp) : 1;
  const partnerRecall = tp + fn ? tp / (tp + fn) : 1;

  return {
    leadCount: { correct: countCorrect, withinTolerance: countWithinTol, total: gt.sessions.length },
    fieldPrecision: { correct: fieldCorrect, populated: fieldPopulated, precision },
    crossContamination: { contaminated, total: created.length, rate: created.length ? contaminated / created.length : 0 },
    partner: { tp, fp, fn, precision: partnerPrecision, recall: partnerRecall },
    nonLead: { falsePositives: nonLeadFP, falseNegatives: nonLeadFN },
    totalCreated: created.length,
  };
}

/** Greedy match of expected leads to actual leads by name/company overlap. */
function matchLeads(
  expected: GtLead[],
  actual: ScoredLead[],
): Array<{ expected: GtLead | null; actual: ScoredLead | null }> {
  const pairs: Array<{ expected: GtLead | null; actual: ScoredLead | null }> = [];
  const used = new Set<number>();
  for (const exp of expected) {
    let matchIdx = -1;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const a = actual[i]!;
      if (
        (exp.name && a.name && loosely(a.name, exp.name)) ||
        (exp.company && a.company && loosely(a.company, exp.company))
      ) {
        matchIdx = i;
        break;
      }
    }
    // Fall back to positional match when no field overlap (single-lead sessions).
    if (matchIdx === -1) {
      for (let i = 0; i < actual.length; i++) {
        if (!used.has(i)) {
          matchIdx = i;
          break;
        }
      }
    }
    if (matchIdx >= 0) {
      used.add(matchIdx);
      pairs.push({ expected: exp, actual: actual[matchIdx]! });
    } else {
      pairs.push({ expected: exp, actual: null });
    }
  }
  return pairs;
}
