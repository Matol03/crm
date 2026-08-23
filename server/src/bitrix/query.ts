/**
 * PHP-style nested query encoding for Bitrix `batch` command strings
 * (e.g. `crm.lead.add?fields[TITLE]=X&fields[PHONE][0][VALUE]=...`).
 *
 * Non-batch calls POST JSON directly and don't need this; only the `cmd`
 * values inside a batch request are query strings.
 */

function encodePair(key: string, value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => encodePair(`${key}[${i}]`, v, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      encodePair(`${key}[${k}]`, v, out);
    }
  } else {
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
}

/** Encode a params object into a PHP-style query string (no leading `?`). */
export function phpQuery(params: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) encodePair(k, v, out);
  return out.join('&');
}

/** Build one batch command value: `method?encoded-params`. */
export function encodeCmd(method: string, params: Record<string, unknown>): string {
  const q = phpQuery(params);
  return q ? `${method}?${q}` : method;
}
