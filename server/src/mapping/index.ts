/**
 * Reference-list mapping (PRD Section 9).
 *
 * Free-text extraction values -> Bitrix numeric list IDs. Match order:
 *   1. exact (case-insensitive)
 *   2. fuzzy: small synonym table, then normalized-edit-distance threshold
 *   3. no match -> null (leave Bitrix field blank; original wording preserved
 *      upstream in COMMENTS/warnings — "empty beats wrong").
 *
 * The label->id table is supplied live from `list_value_cache` at runtime;
 * this module never hard-codes IDs.
 */

export interface ListValue {
  label: string;
  id: number;
}

export interface MapResult {
  id: number | null;
  matchedLabel: string | null;
  method: 'exact' | 'synonym' | 'fuzzy' | 'none';
}

/** Per-field synonym hints (maintained by us; extend as needed). */
export const SYNONYMS: Record<string, Record<string, string>> = {
  UF_CRM_PRODUCT_INTEREST: {
    integration: 'Integration Services',
    'integration services': 'Integration Services',
    'integration and analytics': 'Analytics',
    analytics: 'Analytics',
    reporting: 'Analytics',
    platform: 'Platform/Core',
    core: 'Platform/Core',
    support: 'Support & SLA',
    sla: 'Support & SLA',
    training: 'Training',
    oem: 'OEM/White label',
    'white label': 'OEM/White label',
  },
  UF_CRM_PRIORITY: {
    urgent: 'High',
    asap: 'High',
    high: 'High',
    medium: 'Medium',
    normal: 'Medium',
    low: 'Low',
  },
  UF_CRM_REGION: {
    germany: 'Europe',
    france: 'Europe',
    eu: 'Europe',
    kazakhstan: 'CIS',
    russia: 'CIS',
    uae: 'Middle East',
    emirates: 'Middle East',
    usa: 'North America',
    'united states': 'North America',
  },
};

export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Levenshtein edit distance. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n]!;
}

/** Similarity in [0,1], 1 = identical. */
export function similarity(a: string, b: string): number {
  const dist = editDistance(a, b);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - dist / max;
}

/**
 * Map free text to a list id for one field.
 * @param fuzzyThreshold minimum similarity to accept a fuzzy match (0..1).
 */
export function mapToListId(
  fieldCode: string,
  text: string | null,
  values: ListValue[],
  fuzzyThreshold = 0.82,
): MapResult {
  if (!text || !text.trim() || values.length === 0) {
    return { id: null, matchedLabel: null, method: 'none' };
  }
  const needle = normalize(text);

  // 1. exact (case-insensitive)
  for (const v of values) {
    if (normalize(v.label) === needle) {
      return { id: v.id, matchedLabel: v.label, method: 'exact' };
    }
  }

  // 2a. synonym table -> canonical label -> exact
  const table = SYNONYMS[fieldCode];
  if (table) {
    // Longest-key-first so multi-word synonyms win over substrings.
    const keys = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (needle === key || needle.includes(key)) {
        const canonical = normalize(table[key]!);
        const hit = values.find((v) => normalize(v.label) === canonical);
        if (hit) return { id: hit.id, matchedLabel: hit.label, method: 'synonym' };
      }
    }
  }

  // 2b. fuzzy by similarity
  let best: { v: ListValue; score: number } | null = null;
  for (const v of values) {
    const score = similarity(needle, normalize(v.label));
    if (!best || score > best.score) best = { v, score };
  }
  if (best && best.score >= fuzzyThreshold) {
    return { id: best.v.id, matchedLabel: best.v.label, method: 'fuzzy' };
  }

  // 3. no match
  return { id: null, matchedLabel: null, method: 'none' };
}
