import { describe, it, expect } from 'vitest';
import { GeminiLlmClient } from '../src/llm/gemini.js';
import type { ChatTransport } from '../src/llm/validate.js';

function clientWith(responses: string[]): GeminiLlmClient {
  let i = 0;
  const transport: ChatTransport = async () => responses[Math.min(i++, responses.length - 1)]!;
  return new GeminiLlmClient({ apiKey: 'unused', transport });
}

describe('GeminiLlmClient.segment', () => {
  it('parses valid segmentation and filters unknown ids', async () => {
    const c = clientWith(['{"segments":[{"segmentId":"seg-1","messageIds":["m1","zzz"]}]}']);
    const res = await c.segment({ items: [{ messageId: 'm1', timestamp: 't', type: 'text', text: 'a' }] });
    expect(res.segments[0]!.messageIds).toEqual(['m1']);
  });
});

describe('GeminiLlmClient.extract', () => {
  const valid = JSON.stringify({
    name: 'Anna Weber', company: 'BMW AG', position: null, country: 'Germany',
    phones: [{ value: '+49123', type: 'WORK' }], emails: [{ value: 'anna@bmw.de', type: 'WORK' }],
    productInterestRaw: 'analytics', priorityRaw: null, leadTypeRaw: 'customer',
    confidence: { name: 0.9 }, summaryRu: 'Резюме', verbatim: 'text',
  });

  it('parses a valid extraction', async () => {
    const r = await clientWith([valid]).extract({ segmentText: 'text', cardText: null });
    expect(r.name).toBe('Anna Weber');
    expect(r.emails[0]!.value).toBe('anna@bmw.de');
  });

  it('retries on malformed JSON then succeeds', async () => {
    const r = await clientWith(['not json', valid]).extract({ segmentText: 'text', cardText: null });
    expect(r.company).toBe('BMW AG');
  });

  it('throws after exhausting retries', async () => {
    await expect(clientWith(['x', 'y', 'z', 'w']).extract({ segmentText: 't', cardText: null })).rejects.toThrow(/invalid JSON/);
  });
});
