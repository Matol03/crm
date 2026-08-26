import { describe, it, expect } from 'vitest';
import { generateContent, modelChain, candidateText, DEFAULT_MODEL } from '../src/llm/geminiEndpoint.js';

/** Retry immediately: the behaviour under test is the model switch, not the wait. */
const FAST = { baseDelayMs: 0, sleep: async () => {} };

/** A fetch stub that answers per-model, so a chain can be driven deterministically. */
function fetchByModel(answers: Record<string, number | 'ok'>): typeof fetch {
  return (async (url: string) => {
    const model = /models\/([^:]+):/.exec(String(url))![1]!;
    const answer = answers[model] ?? 404;
    if (answer === 'ok') {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: `served by ${model}` }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{"error":{"code":' + answer + '}}', { status: answer as number });
  }) as unknown as typeof fetch;
}

describe('model chain', () => {
  it('puts the configured model first and keeps the rest as backup', () => {
    const chain = modelChain('gemini-3.6-flash');
    expect(chain[0]).toBe('gemini-3.6-flash');
    expect(chain).toContain(DEFAULT_MODEL);
    // No model appears twice, or a retry would be wasted on a spent quota.
    expect(new Set(chain).size).toBe(chain.length);
  });

  it('falls back to the default chain when nothing is configured', () => {
    expect(modelChain(undefined)[0]).toBe(DEFAULT_MODEL);
    expect(modelChain('   ')[0]).toBe(DEFAULT_MODEL);
  });
});

describe('generateContent', () => {
  it('uses the primary model when it works', async () => {
    const json = await generateContent({
      apiKey: 'k', models: ['a', 'b'], body: {}, retry: FAST,
      fetchImpl: fetchByModel({ a: 'ok', b: 'ok' }),
    });
    expect(candidateText(json)).toBe('served by a');
  });

  it('moves to the next model when the first one has spent its quota', async () => {
    // 429 is a daily allowance, not a transient blip: no backoff can fix it,
    // but the next model has an allowance of its own.
    const switches: Array<{ from: string; to: string; status: number }> = [];
    const json = await generateContent({
      apiKey: 'k', models: ['a', 'b'], body: {}, retry: FAST,
      fetchImpl: fetchByModel({ a: 429, b: 'ok' }),
      onFallback: (e) => switches.push(e),
    });
    expect(candidateText(json)).toBe('served by b');
    expect(switches).toEqual([{ from: 'a', to: 'b', status: 429 }]);
  });

  it('moves on when a model stays overloaded after retries', async () => {
    const json = await generateContent({
      apiKey: 'k', models: ['a', 'b'], body: {}, retry: FAST,
      fetchImpl: fetchByModel({ a: 503, b: 'ok' }),
    });
    expect(candidateText(json)).toBe('served by b');
  });

  it('names every model tried when all of them are exhausted', async () => {
    await expect(generateContent({
      apiKey: 'k', models: ['a', 'b'], body: {}, retry: FAST,
      fetchImpl: fetchByModel({ a: 429, b: 429 }),
    })).rejects.toThrow(/every model exhausted \(a, b\)/);
  });

  it('does not switch model for an error the next model would also give', async () => {
    // A malformed request (400) fails identically everywhere; walking the chain
    // would just burn quota on all of them.
    await expect(generateContent({
      apiKey: 'k', models: ['a', 'b'], body: {}, retry: FAST,
      fetchImpl: fetchByModel({ a: 400, b: 'ok' }),
    })).rejects.toThrow(/HTTP 400 \(model a\)/);
  });
});
