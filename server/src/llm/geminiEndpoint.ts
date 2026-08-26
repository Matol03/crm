/**
 * One place that calls Gemini, shared by extraction, card OCR and speech.
 *
 * Why this exists: each model has its OWN free-tier daily allowance, and the
 * two failure modes look similar but are not:
 *
 *   503 — the model is momentarily overloaded. Retrying works.
 *   429 — that model's quota is spent for the day. Retrying never works,
 *         no matter how long the backoff.
 *
 * Betting the whole pipeline on a single model means either failure stops
 * every lead. So a request walks a list of models: retry transient errors on
 * the current one, and on a spent quota move to the next model, which has its
 * own separate allowance. Only when every model is exhausted does the call
 * fail — and it says which models were tried.
 */

import { fetchWithRetry } from './validate.js';

export interface GeminiCallOptions {
  apiKey: string;
  baseUrl?: string;
  /** Primary model first; each subsequent entry is a fallback. */
  models: string[];
  body: unknown;
  fetchImpl?: typeof fetch;
  /** Reports which model actually served the request, and why a switch happened. */
  onFallback?: (e: { from: string; to: string; status: number }) => void;
  /** Retry timing. Injectable so tests do not sit through real backoff waits. */
  retry?: { maxRetries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
}

export const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Models tried in order when nothing is configured. 2.5-flash leads because it
 * is the most reliably available on the free tier; the others each bring an
 * independent daily allowance, so a spent quota is not the end of the day.
 */
export const DEFAULT_MODEL_CHAIN = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash-lite'];

/** Build the model chain: the configured model first, then the rest as backup. */
export function modelChain(configured?: string): string[] {
  const primary = configured?.trim() || DEFAULT_MODEL;
  return [primary, ...DEFAULT_MODEL_CHAIN.filter((m) => m !== primary)];
}

/** Text of the first candidate, joining the parts the model returned. */
export function candidateText(json: unknown): string {
  const j = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
}

/**
 * Call generateContent, moving to the next model when the current one's quota
 * is exhausted. Returns the parsed JSON response.
 */
export async function generateContent(opts: GeminiCallOptions): Promise<unknown> {
  const baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const models = opts.models.length ? opts.models : [DEFAULT_MODEL];
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
  };

  let lastStatus = 0;
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const res = await fetchWithRetry(
      doFetch,
      `${baseUrl}/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
      init,
      opts.retry ?? {},
    );
    if (res.ok) return res.json();

    lastStatus = res.status;
    const spentQuota = res.status === 429;
    const stillOverloaded = res.status === 503;
    const next = models[i + 1];

    // Both are worth switching model for: a spent quota cannot recover today,
    // and a model that is still overloaded after backoff will likely stay so.
    if (spentQuota || stillOverloaded) {
      if (next) {
        opts.onFallback?.({ from: model, to: next, status: res.status });
        continue;
      }
      // The last model is out too: report the whole chain, because the operator
      // needs to know everything is spent, not just this one model.
      break;
    }
    // Anything else (a malformed request, a bad key) fails the same way on every
    // model, so walking the chain would only burn the remaining allowances.
    throw new Error(`Gemini HTTP ${res.status} (model ${model})`);
  }
  throw new Error(
    `Gemini unavailable: every model exhausted (${models.join(', ')}); last status ${lastStatus}`,
  );
}
