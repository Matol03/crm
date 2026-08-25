import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import { PlatformLeadStore } from '../src/platform/store.js';
import { DualLeadSink } from '../src/platform/dual.js';
import { PlatformRepo } from '../src/api/platformRepo.js';
import { MockBitrixClient } from '../src/bitrix/mock.js';
import type { BitrixClient, LeadWrite, LeadWriteResult } from '../src/contracts/index.js';

function freshDb(): Db {
  return new Db(':memory:');
}

function write(over: Partial<LeadWrite> = {}): LeadWrite {
  return {
    localId: 'sess-1#seg-1',
    sessionId: 'sess-1',
    title: 'Anna Petrova — Nordwind',
    assignedById: 21,
    name: 'Anna Petrova',
    company: 'Nordwind',
    position: 'CTO',
    country: 'Germany',
    phones: [{ value: '+49 30 1234567', type: 'WORK' }],
    emails: [{ value: 'anna@nordwind.example', type: 'WORK' }],
    listFields: { leadTypeId: 47, priorityId: 83 },
    verbatim: 'met at booth',
    aiSummaryRu: 'кратко',
    service: { teamsGroupId: 'g', teamsMessageIds: ['m1'], teamsAuthor: 'rep@example.com' },
    warnings: [],
    needsAttachmentRetry: false,
    ...over,
  };
}

/** A portal client that always fails, to prove the local lead survives. */
class BrokenBitrix implements BitrixClient {
  async listUserFieldValues(): Promise<Array<{ label: string; id: number }>> {
    throw new Error('portal unreachable');
  }
  async findDuplicate(): Promise<null> { return null; }
  async writeLeads(): Promise<LeadWriteResult[]> { throw new Error('401 insufficient_scope'); }
  async getLead(): Promise<null> { return null; }
  leadUrl(id: number): string { return `https://portal.example/crm/lead/details/${id}/`; }
}

function sink(db: Db, bitrix: BitrixClient) {
  return new DualLeadSink({ db, platform: new PlatformLeadStore({ db }), bitrix });
}

describe('dual sink — leads go to both stores', () => {
  it('writes to the platform and mirrors to Bitrix', async () => {
    const db = freshDb();
    const portal = new MockBitrixClient();
    const [res] = await sink(db, portal).writeLeads([write()]);

    // The id handed back is the PLATFORM id — the console links by it.
    expect(res!.error).toBeNull();
    expect(res!.bitrixLeadId).toBe(1);

    const row = db.handle
      .prepare('SELECT bitrix_lead_id, bitrix_error, bitrix_synced_at FROM platform_leads WHERE local_id = ?')
      .get('sess-1#seg-1') as { bitrix_lead_id: number | null; bitrix_error: string | null; bitrix_synced_at: string | null };
    expect(row.bitrix_lead_id).toBeGreaterThan(0);   // mirrored
    expect(row.bitrix_error).toBeNull();
    expect(row.bitrix_synced_at).not.toBeNull();
    db.close();
  });

  it('keeps the lead locally when the portal write fails', async () => {
    // The whole point of local-primary: a portal outage must never lose a lead.
    const db = freshDb();
    const [res] = await sink(db, new BrokenBitrix()).writeLeads([write()]);

    expect(res!.error).toBeNull();          // not a pipeline failure
    expect(res!.bitrixLeadId).toBe(1);      // stored locally

    const repo = new PlatformRepo({ db });
    const leads = await repo.leads();
    expect(leads).toHaveLength(1);
    expect(leads[0]!.name).toBe('Anna Petrova');

    const row = db.handle
      .prepare('SELECT bitrix_lead_id, bitrix_error FROM platform_leads WHERE local_id = ?')
      .get('sess-1#seg-1') as { bitrix_lead_id: number | null; bitrix_error: string | null };
    expect(row.bitrix_lead_id).toBeNull();
    // ...and the failure is recorded, not swallowed.
    expect(row.bitrix_error).toMatch(/insufficient_scope/);
    db.close();
  });

  it('surfaces the mirror failure to the console', async () => {
    const db = freshDb();
    await sink(db, new BrokenBitrix()).writeLeads([write()]);
    const [lead] = await new PlatformRepo({ db }).leads();
    const l = lead as unknown as { crmLeadId: number | null; crmError: string | null; crmUrl: string | null };
    expect(l.crmLeadId).toBeNull();
    expect(l.crmError).toMatch(/insufficient_scope/);
    db.close();
  });

  it('builds a portal link for a mirrored lead without leaking the webhook', async () => {
    const db = freshDb();
    await sink(db, new MockBitrixClient()).writeLeads([write()]);
    const repo = new PlatformRepo({
      db,
      bitrixWebhookUrl: 'https://portal.example.kz/rest/21/SUPERSECRETTOKEN/',
    });
    const [lead] = await repo.leads();
    const l = lead as unknown as { crmUrl: string | null };
    expect(l.crmUrl).toContain('https://portal.example.kz/crm/lead/details/');
    // The webhook token must never end up in a link rendered to the browser.
    expect(l.crmUrl).not.toContain('SUPERSECRETTOKEN');
    db.close();
  });

  it('deduplicates against the platform, not the portal', async () => {
    // Bitrix may be missing leads whose mirror failed; asking it would
    // re-create a duplicate the platform already holds.
    const db = freshDb();
    const s = sink(db, new BrokenBitrix());
    await s.writeLeads([write()]);
    const [second] = await s.writeLeads([write({ localId: 'sess-2#seg-1', sessionId: 'sess-2' })]);

    expect(second!.updatedExisting).toBe(true);
    expect(await new PlatformRepo({ db }).leads()).toHaveLength(1);
    db.close();
  });

  it('falls back to the seeded list values when the portal cannot be reached', async () => {
    const db = freshDb();
    const values = await sink(db, new BrokenBitrix()).listUserFieldValues('UF_CRM_LEAD_TYPE');
    expect(values.find((v) => v.label === 'Customer')?.id).toBe(47);
    db.close();
  });
});
