import { describe, it, expect } from 'vitest';
import { HeuristicLlmClient } from '../src/llm/mock.js';
import type { SessionItem } from '../src/contracts/index.js';

const llm = new HeuristicLlmClient();

function img(id: string, name: string): SessionItem {
  return { messageId: id, timestamp: '2026-08-22T10:00:00Z', type: 'image', ocrText: `Name: ${name}` };
}
function txt(id: string, text: string): SessionItem {
  return { messageId: id, timestamp: '2026-08-22T10:00:00Z', type: 'text', text };
}

describe('HeuristicLlmClient.segment', () => {
  it('splits three back-to-back cards into three segments', async () => {
    const res = await llm.segment({ items: [img('a', 'John'), img('b', 'Marie'), img('c', 'Chen')] });
    expect(res.segments).toHaveLength(3);
  });

  it('keeps one contact (text + its card) as a single segment', async () => {
    const res = await llm.segment({ items: [txt('t', 'met a prospect'), img('a', 'John')] });
    expect(res.segments).toHaveLength(1);
    expect(res.segments[0]!.messageIds).toEqual(['t', 'a']);
  });

  it('splits on an explicit separator phrase', async () => {
    const res = await llm.segment({
      items: [txt('t1', 'John from Acme'), txt('t2', 'second contact: Marie from Airbus')],
    });
    expect(res.segments).toHaveLength(2);
  });
});

describe('HeuristicLlmClient.extract', () => {
  it('pulls email and phone via regex with high confidence', async () => {
    const r = await llm.extract({
      segmentText: 'reach me at john@acme.com or +12025550101',
      cardText: null,
    });
    expect(r.emails[0]!.value).toBe('john@acme.com');
    expect(r.phones[0]!.value).toBe('+12025550101');
    expect(r.confidence.emails).toBeGreaterThanOrEqual(0.6);
  });

  it('parses structured card fields', async () => {
    const r = await llm.extract({
      segmentText: '',
      cardText: 'Name: Anna Weber\nCompany: BMW AG\nPosition: Head of Data\nCountry: Germany',
    });
    expect(r.name).toBe('Anna Weber');
    expect(r.company).toBe('BMW AG');
    expect(r.country).toBe('Germany');
  });

  it('flags partner from lexical marker', async () => {
    const r = await llm.extract({ segmentText: 'wants to be a reseller', cardText: null });
    expect(r.leadTypeRaw).toBe('partner');
  });
});
