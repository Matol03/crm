import { describe, it, expect } from 'vitest';
import { applyGate } from '../src/extraction/gating.js';
import type { RawExtraction } from '../src/contracts/index.js';

function raw(overrides: Partial<RawExtraction> = {}): RawExtraction {
  return {
    name: 'Anna Weber',
    company: 'BMW AG',
    position: 'Head of Data',
    country: 'Germany',
    phones: [{ value: '+498912345678', type: 'WORK' }],
    emails: [{ value: 'anna@bmw.de', type: 'WORK' }],
    productInterestRaw: 'analytics',
    priorityRaw: 'high',
    leadTypeRaw: 'customer',
    confidence: { name: 0.95, company: 0.9, position: 0.9, country: 0.9, phones: 0.9, emails: 0.9 },
    summaryRu: 'summary',
    verbatim: 'verbatim',
    ...overrides,
  };
}

const opts = { confidenceThreshold: 0.6 };

describe('applyGate: confidence gating', () => {
  it('keeps high-confidence fields', () => {
    const g = applyGate(raw(), opts, 'src');
    expect(g.name).toBe('Anna Weber');
    expect(g.emails).toHaveLength(1);
  });

  it('nulls a low-confidence scalar and warns', () => {
    const g = applyGate(raw({ confidence: { ...raw().confidence, name: 0.4 } }), opts, 'src');
    expect(g.name).toBeNull();
    expect(g.warnings.some((w) => /name below confidence/.test(w))).toBe(true);
  });

  it('drops low-confidence emails with a warning', () => {
    const g = applyGate(raw({ confidence: { ...raw().confidence, emails: 0.3 } }), opts, 'src');
    expect(g.emails).toHaveLength(0);
    expect(g.warnings.some((w) => /emails below confidence/.test(w))).toBe(true);
  });
});

describe('applyGate: validators', () => {
  it('drops a malformed email even at high confidence', () => {
    const g = applyGate(raw({ emails: [{ value: 'not-an-email', type: 'WORK' }] }), opts, 'src');
    expect(g.emails).toHaveLength(0);
    expect(g.warnings.some((w) => /email failed format/.test(w))).toBe(true);
  });

  it('drops a too-short phone', () => {
    const g = applyGate(raw({ phones: [{ value: '123', type: 'MOBILE' }] }), opts, 'src');
    expect(g.phones).toHaveLength(0);
  });
});

describe('applyGate: Partner double-check', () => {
  it('keeps Customer by default', () => {
    expect(applyGate(raw(), opts, 'src').leadType).toBe('customer');
  });

  it('sets Partner only with an independent lexical marker', () => {
    const withMarker = applyGate(raw({ leadTypeRaw: 'partner' }), opts, 'they want to be a reseller');
    expect(withMarker.leadType).toBe('partner');
  });

  it('downgrades Partner to Customer when no marker is present', () => {
    const noMarker = applyGate(raw({ leadTypeRaw: 'partner' }), opts, 'just a normal customer chat');
    expect(noMarker.leadType).toBe('customer');
    expect(noMarker.warnings.some((w) => /no lexical marker/.test(w))).toBe(true);
  });
});
