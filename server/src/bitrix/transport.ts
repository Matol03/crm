/**
 * Bitrix REST transport (PRD Section 10.1).
 *
 * The webhook URL *is* the credential — held here only, never logged, never
 * returned. A single call posts JSON params to `${webhookUrl}<method>.json`.
 * The transport is an injectable function so tests stub it and never touch a
 * real portal.
 */

export interface BitrixEnvelope<T = unknown> {
  result: T;
  error?: string;
  error_description?: string;
  /** Per-sub-call errors in a batch response, keyed by cmd name. */
  result_error?: Record<string, { error: string; error_description?: string }>;
  time?: unknown;
}

export type BitrixTransport = (
  method: string,
  params: Record<string, unknown>,
) => Promise<{ status: number; body: BitrixEnvelope }>;

/** Real HTTP transport over fetch. `webhookUrl` must end with a trailing slash. */
export function createHttpTransport(webhookUrl: string): BitrixTransport {
  const base = webhookUrl.endsWith('/') ? webhookUrl : `${webhookUrl}/`;
  return async (method, params) => {
    const res = await fetch(`${base}${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    let body: BitrixEnvelope;
    try {
      body = (await res.json()) as BitrixEnvelope;
    } catch {
      body = { result: null as unknown as never };
    }
    return { status: res.status, body };
  };
}

/** Portal origin (no secret) from the webhook URL, for building card links. */
export function portalOrigin(webhookUrl: string): string {
  try {
    return new URL(webhookUrl).origin;
  } catch {
    return '';
  }
}
