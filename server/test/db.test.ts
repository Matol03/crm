import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import type { SessionBundle } from '../src/contracts/index.js';

function freshDb(): Db {
  return new Db(':memory:');
}

const bundle: SessionBundle = {
  sessionId: 'teams|t|hash',
  channel: { teamsGroupId: 'g', channelId: 'c' },
  author: { teamsUserId: 'u', email: 'a@x.com', displayName: 'A' },
  sessionWindow: { openedAt: '2026-08-22T10:00:00Z', closedAt: '2026-08-22T10:01:00Z' },
  items: [{ messageId: 'm1', timestamp: '2026-08-22T10:00:00Z', type: 'text', text: 'hi' }],
};

describe('idempotency ledger', () => {
  it('records and detects processed messages', () => {
    const db = freshDb();
    db.upsertSession(bundle, 'received');
    expect(db.allProcessed(['m1'])).toBe(false);
    db.markProcessed(['m1', 'm2'], bundle.sessionId);
    expect(db.allProcessed(['m1', 'm2'])).toBe(true);
    expect(db.alreadyProcessed(['m1', 'm3'])).toEqual(new Set(['m1']));
    db.close();
  });

  it('markProcessed is idempotent (INSERT OR IGNORE)', () => {
    const db = freshDb();
    db.upsertSession(bundle, 'received');
    db.markProcessed(['m1'], bundle.sessionId);
    expect(() => db.markProcessed(['m1'], bundle.sessionId)).not.toThrow();
    expect(db.allProcessed(['m1'])).toBe(true);
    db.close();
  });

  it('empty set is treated as fully processed (noop-safe)', () => {
    const db = freshDb();
    expect(db.allProcessed([])).toBe(true);
    db.close();
  });
});

describe('employee_map + campaign + list cache', () => {
  it('resolves owner and falls back to null when unmapped', () => {
    const db = freshDb();
    db.setEmployee('a@x.com', 42, 'A');
    expect(db.getBitrixUserId('a@x.com')).toBe(42);
    expect(db.getBitrixUserId('unknown@x.com')).toBeNull();
    db.close();
  });

  it('caches and reads list values', () => {
    const db = freshDb();
    db.cacheListValues('UF_CRM_PRIORITY', [{ label: 'High', id: 83 }]);
    expect(db.getCachedListValues('UF_CRM_PRIORITY')).toEqual([{ label: 'High', bitrix_id: 83 }]);
    db.close();
  });

  it('stores campaign config', () => {
    const db = freshDb();
    db.setCampaign('exhibition', 'Hannover Messe 2026');
    expect(db.getCampaign('exhibition')).toBe('Hannover Messe 2026');
    db.close();
  });
});

describe('lead state machine persistence', () => {
  it('advances lead status and records bitrix id', () => {
    const db = freshDb();
    db.upsertSession(bundle, 'received');
    db.insertLead({
      id: 'L1',
      sessionId: bundle.sessionId,
      title: 'T',
      status: 'mapped',
      fieldsJson: '{}',
      verbatim: 'v',
      aiSummaryRu: 's',
      warningsJson: '[]',
      needsAttachmentRetry: false,
    });
    db.setLeadStatus('L1', 'writing_crm');
    db.setLeadBitrixId('L1', 4821);
    db.setLeadStatus('L1', 'done');
    const row = db.getLead('L1')!;
    expect(row.status).toBe('done');
    expect(row.bitrix_lead_id).toBe(4821);
    db.close();
  });
});
