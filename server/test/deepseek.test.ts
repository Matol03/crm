import { describe, it, expect } from 'vitest';
import { DeepSeekLlmClient, parseJsonLoose } from '../src/llm/deepseek.js';
import type { ChatTransport } from '../src/llm/deepseek.js';

function clientWith(responses: string[]): DeepSeekLlmClient {
  let i = 0;
  const transport: ChatTransport = async () => responses[Math.min(i++, responses.length - 1)]!;
  return new DeepSeekLlmClient({ apiKey: 'unused-in-test', transport });
}

describe('parseJsonLoose', () => {
  it('strips code fences and surrounding prose', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
  });
});

describe('DeepSeek.segment', () => {
  it('parses a valid segmentation and keeps only known ids', async () => {
    const c = clientWith(['{"segments":[{"segmentId":"seg-1","messageIds":["m1","x-unknown"]},{"segmentId":"seg-2","messageIds":["m2"]}]}']);
    const res = await c.segment({
      items: [
        { messageId: 'm1', timestamp: 't', type: 'text', text: 'a' },
        { messageId: 'm2', timestamp: 't', type: 'text', text: 'b' },
      ],
    });
    expect(res.segments).toHaveLength(2);
    expect(res.segments[0]!.messageIds).toEqual(['m1']); // unknown id filtered
  });

  it('appends a catch-all segment for messages the model dropped', async () => {
    const c = clientWith(['{"segments":[{"segmentId":"seg-1","messageIds":["m1"]}]}']);
    const res = await c.segment({
      items: [
        { messageId: 'm1', timestamp: 't', type: 'text', text: 'a' },
        { messageId: 'm2', timestamp: 't', type: 'text', text: 'b' },
      ],
    });
    const allIds = res.segments.flatMap((s) => s.messageIds).sort();
    expect(allIds).toEqual(['m1', 'm2']); // nothing lost
  });
});

describe('DeepSeek.extract', () => {
  const valid = JSON.stringify({
    name: 'Anna Weber',
    company: 'BMW AG',
    position: null,
    country: 'Germany',
    phones: [{ value: '+498912345678', type: 'WORK' }],
    emails: [{ value: 'anna@bmw.de', type: 'WORK' }],
    productInterestRaw: 'analytics',
    priorityRaw: null,
    leadTypeRaw: 'customer',
    confidence: { name: 0.9, emails: 0.8 },
    summaryRu: 'Резюме',
    verbatim: 'text',
  });

  it('parses a valid extraction', async () => {
    const r = await clientWith([valid]).extract({ segmentText: 'text', cardText: null });
    expect(r.name).toBe('Anna Weber');
    expect(r.emails[0]!.value).toBe('anna@bmw.de');
    expect(r.confidence.name).toBe(0.9);
  });

  it('retries on malformed JSON then succeeds (<=2 retries, S8)', async () => {
    const r = await clientWith(['not json', valid]).extract({ segmentText: 'text', cardText: null });
    expect(r.company).toBe('BMW AG');
  });

  it('throws after exhausting retries so the segment can be failed loudly', async () => {
    await expect(clientWith(['nope', 'still nope', 'nope again', 'nope']).extract({ segmentText: 't', cardText: null })).rejects.toThrow(/invalid JSON/);
  });

  it('falls back to assembled verbatim when the model omits it', async () => {
    const noVerbatim = JSON.stringify({
      name: null, company: null, position: null, country: null, phones: [], emails: [],
      productInterestRaw: null, priorityRaw: null, leadTypeRaw: 'unclear',
      confidence: {}, summaryRu: 'x', verbatim: '',
    });
    const r = await clientWith([noVerbatim]).extract({ segmentText: 'seg text', cardText: 'card text' });
    expect(r.verbatim).toContain('card text');
    expect(r.verbatim).toContain('seg text');
  });
});
