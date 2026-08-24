import { describe, it, expect } from 'vitest';
import { resolveProvenance } from '../src/extraction/provenance.js';
import type { SessionItem, GatedExtraction } from '../src/contracts/index.js';

const voice: SessionItem = {
  messageId: 'm-voice', timestamp: '2026-08-22T10:00:00Z', type: 'voice',
  transcript: 'Это Саша Петров из Siemens, интересуется аналитикой. Нужно срочно отправить КП до пятницы.',
};
const card: SessionItem = {
  messageId: 'm-card', timestamp: '2026-08-22T10:20:00Z', type: 'image',
  ocrText: 'Aleksandr Ivanovich Petrov\nCTO\nSiemens AG\na.petrov@siemens.com\n+49 170 1234567\nMunich, Germany',
};
const text: SessionItem = {
  messageId: 'm-text', timestamp: '2026-08-22T10:21:00Z', type: 'text',
  text: 'Send proposal by Friday.',
};

function gated(over: Partial<GatedExtraction> = {}): GatedExtraction {
  return {
    name: 'Aleksandr Ivanovich Petrov',
    company: 'Siemens AG',
    position: 'CTO',
    country: 'Germany',
    phones: [{ value: '+49 170 1234567', type: 'WORK' }],
    emails: [{ value: 'a.petrov@siemens.com', type: 'WORK' }],
    productInterestRaw: 'analytics',
    priorityRaw: 'urgent',
    leadType: 'customer',
    summaryRu: 's', verbatim: 'v',
    confidence: {}, provenance: {}, warnings: [],
    ...over,
  };
}

describe('resolveProvenance', () => {
  const items = [voice, card, text];

  it('locates values that appear verbatim in a message', () => {
    const p = resolveProvenance(items, gated());
    expect(p.name).toMatchObject({ messageId: 'm-card', method: 'value' });
    expect(p.company).toMatchObject({ messageId: 'm-card' });
    expect(p.email).toMatchObject({ messageId: 'm-card' });
  });

  it('matches a phone across different formatting (digits only)', () => {
    const p = resolveProvenance(items, gated({ phones: [{ value: '+491701234567', type: 'WORK' }] }));
    expect(p.phone).toMatchObject({ messageId: 'm-card', method: 'value' });
  });

  it("prefers the model's quote and records method 'quote'", () => {
    const p = resolveProvenance(items, gated(), { priority: 'Нужно срочно отправить КП до пятницы.' });
    expect(p.priority).toMatchObject({ messageId: 'm-voice', method: 'quote' });
    expect(p.priority!.quote).toContain('срочно');
  });

  it("marks a value it cannot locate as 'inferred' rather than guessing a message", () => {
    const p = resolveProvenance(items, gated({ priorityRaw: 'High' }));
    expect(p.priority).toMatchObject({ messageId: null, method: 'inferred' });
  });

  it('applies source priority — the card wins over the voice note', () => {
    // "Siemens" appears in both; the card must win (card > text > voice).
    const p = resolveProvenance(items, gated({ company: 'Siemens' }));
    expect(p.company!.messageId).toBe('m-card');
  });

  it('skips fields with no value', () => {
    const p = resolveProvenance(items, gated({ position: null, emails: [] }));
    expect(p.position).toBeUndefined();
    expect(p.email).toBeUndefined();
  });

  it('claims no message when there are no source messages', () => {
    const p = resolveProvenance([], gated());
    // Every populated field is still reported, but explicitly as un-attributed
    // rather than silently omitted or pinned to an arbitrary message.
    expect(Object.keys(p).length).toBeGreaterThan(0);
    expect(Object.values(p).every((v) => v.messageId === null && v.method === 'inferred')).toBe(true);
  });
});
