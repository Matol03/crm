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

describe('deleting and merging', () => {
  it('deletes the lead here and removes its copy from the portal', async () => {
    const db = freshDb();
    const portal = new MockBitrixClient();
    const s = sink(db, portal);
    const [res] = await s.writeLeads([write()]);
    const portalId = (db.handle
      .prepare('SELECT bitrix_lead_id FROM platform_leads WHERE id = ?')
      .get(res!.bitrixLeadId!) as { bitrix_lead_id: number }).bitrix_lead_id;
    expect(await portal.getLead(portalId)).not.toBeNull();

    await s.deleteLead(res!.bitrixLeadId!);

    expect(await new PlatformRepo({ db }).leads()).toHaveLength(0);
    // No orphan left behind for the sales team to work.
    expect(await portal.getLead(portalId)).toBeNull();
    db.close();
  });

  it('reports when the local delete succeeded but the portal did not', async () => {
    const db = freshDb();
    const portal = new MockBitrixClient();
    const s = sink(db, portal);
    const [res] = await s.writeLeads([write()]);
    // Portal forgets the lead independently, so its delete will fail.
    portal.deleteLead = async () => { throw new Error('403 forbidden'); };

    await expect(s.deleteLead(res!.bitrixLeadId!)).rejects.toThrow(/not in Bitrix24/);
    // The local deletion still stands — silently keeping it would be worse.
    expect(await new PlatformRepo({ db }).leads()).toHaveLength(0);
    db.close();
  });

  it('merges a duplicate into the survivor, filling only its gaps', async () => {
    const db = freshDb();
    const s = sink(db, new MockBitrixClient());
    const [keep] = await s.writeLeads([write({ localId: 'a', company: null, emails: [] })]);
    const [drop] = await s.writeLeads([write({
      localId: 'b', name: 'Anna Petrova', company: 'Nordwind GmbH',
      phones: [{ value: '+49 170 999', type: 'MOBILE' }],
      emails: [{ value: 'anna@nordwind.example', type: 'WORK' }],
      service: { teamsGroupId: 'g', teamsMessageIds: [], teamsAuthor: 'other@example.com' },
    })]);

    await s.mergeLeads(keep!.bitrixLeadId!, drop!.bitrixLeadId!);

    const leads = await new PlatformRepo({ db }).leads();
    expect(leads).toHaveLength(1);
    const merged = leads[0]!;
    expect(merged.bitrixLeadId).toBe(keep!.bitrixLeadId);
    // The gap was filled from the duplicate...
    expect(merged.company).toBe('Nordwind GmbH');
    // ...and both sets of contact details survive.
    expect(merged.phones).toContain('+49 30 1234567');
    expect(merged.phones).toContain('+49 170 999');
    expect(merged.emails).toContain('anna@nordwind.example');
    db.close();
  });

  it('removes the portal copy when a lead is rejected', async () => {
    const db = freshDb();
    const portal = new MockBitrixClient();
    const s = sink(db, portal);
    const [res] = await s.writeLeads([write()]);
    const portalId = (db.handle
      .prepare('SELECT bitrix_lead_id FROM platform_leads WHERE id = ?')
      .get(res!.bitrixLeadId!) as { bitrix_lead_id: number }).bitrix_lead_id;

    await s.setLeadStatus(res!.bitrixLeadId!, 'JUNK');

    expect(await portal.getLead(portalId)).toBeNull();
    // The lead itself remains here, marked rejected, so the decision is visible.
    const lead = await new PlatformRepo({ db }).lead(res!.bitrixLeadId!);
    expect(lead!.statusId).toBe('JUNK');
    expect(lead!.statusLabel).toBe('Rejected');
    db.close();
  });

  it('keeps the portal copy for any other status change', async () => {
    const db = freshDb();
    const portal = new MockBitrixClient();
    const s = sink(db, portal);
    const [res] = await s.writeLeads([write()]);
    const portalId = (db.handle
      .prepare('SELECT bitrix_lead_id FROM platform_leads WHERE id = ?')
      .get(res!.bitrixLeadId!) as { bitrix_lead_id: number }).bitrix_lead_id;

    await s.setLeadStatus(res!.bitrixLeadId!, 'CONVERTED');
    expect(await portal.getLead(portalId)).not.toBeNull();
    db.close();
  });
});

describe('deleting a lead whose portal id was never recorded', () => {
  /** Store a lead the way the backfill did: locally, with no portal id. */
  async function importedWithoutPortalId(db: Db) {
    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write()]);
    db.handle.prepare('UPDATE platform_leads SET bitrix_lead_id = NULL').run();
    return res!.bitrixLeadId!;
  }

  it('finds the portal copy by contact details and removes it', async () => {
    // The reported bug: imported leads had no recorded portal id, so deletion
    // skipped the portal silently and left the copy behind.
    const db = freshDb();
    const portal = new MockBitrixClient();
    // The copy exists in the portal, created during the earlier CRM-only run.
    const [existing] = await portal.writeLeads([write({ localId: 'portal-copy' })]);
    const portalId = existing!.bitrixLeadId!;
    expect(await portal.getLead(portalId)).not.toBeNull();

    const id = await importedWithoutPortalId(db);
    await sink(db, portal).deleteLead(id);

    expect(await new PlatformRepo({ db }).leads()).toHaveLength(0);
    expect(await portal.getLead(portalId)).toBeNull();
    db.close();
  });

  it('says so when no portal copy can be found, instead of reporting success', async () => {
    // Silence here is what let an orphan survive unnoticed.
    const db = freshDb();
    const portal = new MockBitrixClient();   // portal has no matching lead
    const id = await importedWithoutPortalId(db);

    await expect(sink(db, portal).deleteLead(id)).rejects.toThrow(/no matching lead was found/i);
    // The local deletion still stands.
    expect(await new PlatformRepo({ db }).leads()).toHaveLength(0);
    db.close();
  });

  it('does not treat a failed lookup as "there is no copy"', async () => {
    const db = freshDb();
    const portal = new MockBitrixClient();
    portal.findDuplicate = async () => { throw new Error('portal unreachable'); };
    const id = await importedWithoutPortalId(db);

    await expect(sink(db, portal).deleteLead(id)).rejects.toThrow(/no matching lead was found/i);
    db.close();
  });
});

describe('leads with no phone or e-mail', () => {
  /** A portal that can only be searched by title, like the real one. */
  function portalWithTitles(titles: Record<string, number[]>) {
    const deleted: number[] = [];
    const portal = new MockBitrixClient();
    // No comms recorded, so the duplicate search finds nothing — the real
    // situation for a lead captured without a phone or e-mail.
    portal.findDuplicate = async () => null;
    portal.findServiceLeadsByTitle = async (t: string) => titles[t] ?? [];
    portal.deleteLead = async (id: number) => { deleted.push(id); };
    return { portal, deleted };
  }

  async function importedNoComms(db: Db, title: string) {
    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write({ title, phones: [], emails: [] })]);
    db.handle.prepare('UPDATE platform_leads SET bitrix_lead_id = NULL').run();
    return res!.bitrixLeadId!;
  }

  it('finds the portal copy by title when there are no contact details', async () => {
    const db = freshDb();
    const { portal, deleted } = portalWithTitles({ 'Ana Marks — Iron Fist company': [23] });
    const id = await importedNoComms(db, 'Ana Marks — Iron Fist company');

    await sink(db, portal).deleteLead(id);

    expect(deleted).toEqual([23]);
    expect(await new PlatformRepo({ db }).leads()).toHaveLength(0);
    db.close();
  });

  it('removes every copy the portal holds, not just the first', async () => {
    // The portal really does hold more than one copy of some leads; leaving the
    // others behind is the same orphan problem in smaller form.
    const db = freshDb();
    const { portal, deleted } = portalWithTitles({ 'John Newman — Lanterns Organization': [21, 29] });
    const id = await importedNoComms(db, 'John Newman — Lanterns Organization');

    await sink(db, portal).deleteLead(id);

    expect(deleted.sort((a, b) => a - b)).toEqual([21, 29]);
    db.close();
  });

  it('removes the absorbed duplicate from the portal when merging', async () => {
    const db = freshDb();
    const { portal, deleted } = portalWithTitles({ 'Dup — Temporary': [77] });
    const store = new PlatformLeadStore({ db });
    const [keep] = await store.writeLeads([write({ localId: 'keep' })]);
    const [drop] = await store.writeLeads([
      write({
        localId: 'drop', title: 'Dup — Temporary', phones: [], emails: [],
        service: { teamsGroupId: 'g', teamsMessageIds: [], teamsAuthor: 'other@example.com' },
      }),
    ]);
    db.handle.prepare('UPDATE platform_leads SET bitrix_lead_id = NULL WHERE id = ?').run(drop!.bitrixLeadId!);

    await sink(db, portal).mergeLeads(keep!.bitrixLeadId!, drop!.bitrixLeadId!);

    expect(deleted).toEqual([77]);
    expect(await new PlatformRepo({ db }).leads()).toHaveLength(1);
    db.close();
  });

  it('never deletes a lead the service did not create', async () => {
    // findServiceLeadsByTitle filters on the service's own marker field, so a
    // hand-entered lead with the same title is not returned and cannot be lost.
    const db = freshDb();
    const { portal, deleted } = portalWithTitles({});   // portal returns nothing
    const id = await importedNoComms(db, 'Entered By Hand');

    await expect(sink(db, portal).deleteLead(id)).rejects.toThrow(/no matching lead was found/i);
    expect(deleted).toEqual([]);
    db.close();
  });
});

describe('leads the portal holds more than one copy of', () => {
  /** Portal that knows a recorded id AND extra copies under the same title. */
  function portalWithCopies(title: string, ids: number[]) {
    const deleted: number[] = [];
    const portal = new MockBitrixClient();
    portal.findDuplicate = async () => null;
    portal.findServiceLeadsByTitle = async (t: string) => (t === title ? ids : []);
    portal.deleteLead = async (id: number) => { deleted.push(id); };
    return { portal, deleted };
  }

  it('removes every copy, not only the one whose id was recorded', async () => {
    // The reported symptom: the lead vanished here but was still in Bitrix,
    // because a recorded id short-circuited the search and the portal held
    // three copies of that lead.
    const db = freshDb();
    const title = 'Anna Weber — BMW AG';
    const { portal, deleted } = portalWithCopies(title, [5, 19, 27]);

    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write({ title, phones: [], emails: [] })]);
    db.handle.prepare('UPDATE platform_leads SET bitrix_lead_id = 5 WHERE id = ?').run(res!.bitrixLeadId!);

    await sink(db, portal).deleteLead(res!.bitrixLeadId!);

    expect(deleted.sort((a, b) => a - b)).toEqual([5, 19, 27]);
    db.close();
  });

  it('merging removes every copy of the absorbed duplicate', async () => {
    const db = freshDb();
    const title = 'Dup — Twice Over';
    const { portal, deleted } = portalWithCopies(title, [41, 43]);
    const store = new PlatformLeadStore({ db });
    const [keep] = await store.writeLeads([write({ localId: 'keep' })]);
    const [drop] = await store.writeLeads([
      write({
        localId: 'drop', title, phones: [], emails: [],
        service: { teamsGroupId: 'g', teamsMessageIds: [], teamsAuthor: 'other@example.com' },
      }),
    ]);

    await sink(db, portal).mergeLeads(keep!.bitrixLeadId!, drop!.bitrixLeadId!);

    expect(deleted.sort((a, b) => a - b)).toEqual([41, 43]);
    expect(await new PlatformRepo({ db }).leads()).toHaveLength(1);
    db.close();
  });

  it('does not take another lead the copies when two share a title', async () => {
    // Two distinct platform leads with the same title: title-based cleanup is
    // skipped, because it cannot tell whose copies those are.
    const db = freshDb();
    const title = 'Same Name — Same Company';
    const { portal, deleted } = portalWithCopies(title, [61, 63]);

    const store = new PlatformLeadStore({ db });
    const [a] = await store.writeLeads([write({ localId: 'a', title, phones: [{ value: '+49 1', type: 'WORK' }], emails: [] })]);
    await store.writeLeads([
      write({
        localId: 'b', title, phones: [{ value: '+49 2', type: 'WORK' }], emails: [],
        service: { teamsGroupId: 'g', teamsMessageIds: [], teamsAuthor: 'other@example.com' },
      }),
    ]);
    db.handle.prepare('UPDATE platform_leads SET bitrix_lead_id = 61 WHERE id = ?').run(a!.bitrixLeadId!);

    await sink(db, portal).deleteLead(a!.bitrixLeadId!);

    // Only the recorded copy — never the other lead's.
    expect(deleted).toEqual([61]);
    db.close();
  });
});
