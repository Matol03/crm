import { describe, it, expect } from 'vitest';
import { scoreBatch, type GroundTruth, type ScoredLead } from '../src/metrics/score.js';

const gt: GroundTruth = {
  sessions: [
    { name: 's1', sessionId: 'S1', expectedLeadCount: 1, isNonLead: false, leads: [{ name: 'Anna Weber', company: 'BMW AG', hasEmail: true, hasPhone: true, leadType: 'customer' }] },
    { name: 's2', sessionId: 'S2', expectedLeadCount: 1, isNonLead: false, leads: [{ name: 'Carlos Mendez', company: 'DistribuTech', leadType: 'partner' }] },
    { name: 'noise', sessionId: 'S3', expectedLeadCount: 0, isNonLead: true, leads: [] },
  ],
};

describe('scoreBatch', () => {
  it('scores a clean batch: full precision, zero contamination', () => {
    const created: ScoredLead[] = [
      { sessionId: 'S1', name: 'Anna Weber', company: 'BMW AG', emails: ['anna@bmw.de'], phones: ['+49123'], leadType: 'customer' },
      { sessionId: 'S2', name: 'Carlos Mendez', company: 'DistribuTech', emails: [], phones: [], leadType: 'partner' },
    ];
    const r = scoreBatch(gt, created);
    expect(r.leadCount.correct).toBe(3); // S1=1, S2=1, S3=0 all correct
    expect(r.fieldPrecision.precision).toBe(1);
    expect(r.crossContamination.rate).toBe(0);
    expect(r.partner.precision).toBe(1);
    expect(r.partner.recall).toBe(1);
    expect(r.nonLead.falsePositives).toBe(0);
  });

  it('detects cross-contamination when a lead carries another session\'s entity', () => {
    const created: ScoredLead[] = [
      // S1's lead wrongly contains Carlos (belongs to S2).
      { sessionId: 'S1', name: 'Carlos Mendez', company: 'BMW AG', emails: [], phones: [], leadType: 'customer' },
      { sessionId: 'S2', name: 'Carlos Mendez', company: 'DistribuTech', emails: [], phones: [], leadType: 'partner' },
    ];
    const r = scoreBatch(gt, created);
    expect(r.crossContamination.contaminated).toBe(1);
  });

  it('flags a false Partner as precision loss', () => {
    const created: ScoredLead[] = [
      { sessionId: 'S1', name: 'Anna Weber', company: 'BMW AG', emails: [], phones: [], leadType: 'partner' }, // wrong
      { sessionId: 'S2', name: 'Carlos Mendez', company: 'DistribuTech', emails: [], phones: [], leadType: 'partner' },
    ];
    const r = scoreBatch(gt, created);
    expect(r.partner.fp).toBe(1);
    expect(r.partner.precision).toBeLessThan(1);
  });

  it('counts a non-lead false positive', () => {
    const created: ScoredLead[] = [
      { sessionId: 'S3', name: 'Ghost', company: null, emails: [], phones: [], leadType: 'customer' },
    ];
    const r = scoreBatch(gt, created);
    expect(r.nonLead.falsePositives).toBe(1);
  });
});
