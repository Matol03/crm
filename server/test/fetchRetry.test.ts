import { describe, it, expect } from 'vitest';
import { fetchWithRetry } from '../src/llm/validate.js';

function res(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

const noSleep = async () => {};

describe('fetchWithRetry', () => {
  it('returns immediately on success', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return res(200);
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry(f, 'u', {}, { sleep: noSleep });
    expect(r.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('retries a transient 503 then succeeds', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 3 ? res(503) : res(200);
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry(f, 'u', {}, { sleep: noSleep });
    expect(r.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('retries 429 (rate limited)', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 2 ? res(429) : res(200);
    }) as unknown as typeof fetch;
    await fetchWithRetry(f, 'u', {}, { sleep: noSleep });
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-transient 400', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return res(400);
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry(f, 'u', {}, { sleep: noSleep });
    expect(r.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('gives up after maxRetries and returns the last failure', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return res(503);
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry(f, 'u', {}, { sleep: noSleep, maxRetries: 2 });
    expect(r.status).toBe(503);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('honors Retry-After when provided', async () => {
    const waits: number[] = [];
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 2 ? res(429, { 'retry-after': '2' }) : res(200);
    }) as unknown as typeof fetch;
    await fetchWithRetry(f, 'u', {}, { sleep: async (ms) => void waits.push(ms) });
    expect(waits[0]).toBe(2000);
  });
});
