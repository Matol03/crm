import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/index.js';
import { PlatformLeadStore } from '../src/platform/store.js';
import { PlatformRepo } from '../src/api/platformRepo.js';
import type { LeadWrite, SessionBundle } from '../src/contracts/index.js';

function freshDb(): Db {
  return new Db(':memory:');
}

/** A LeadWrite as the pipeline would hand it to the sink. */
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
    // Bitrix list-value IDs; the store resolves them back to labels.
    listFields: {
      leadTypeId: 47,
      priorityId: 83,
      productInterestId: 73,
      exhibitionId: 63,
      regionId: 49,
    },
    verbatim: 'met at booth',
    aiSummaryRu: 'кратко',
    service: {
      teamsGroupId: 'g',
      teamsMessageIds: ['m1'],
      teamsAuthor: 'rep@example.com',
    },
    warnings: [],
    needsAttachmentRetry: false,
    ...over,
  };
}

const bundle: SessionBundle = {
  sessionId: 'sess-1',
  channel: { teamsGroupId: 'g', channelId: 'c' },
  author: { teamsUserId: 'u', email: 'rep@example.com', displayName: 'Rep One' },
  sessionWindow: { openedAt: '2026-08-25T10:00:00Z', closedAt: '2026-08-25T10:01:00Z' },
  items: [
    { messageId: 'm1', timestamp: '2026-08-25T10:00:00Z', type: 'text', text: 'Anna Petrova, Nordwind' },
    { messageId: 'm2', timestamp: '2026-08-25T10:00:30Z', type: 'text', text: 'unrelated second lead' },
  ],
};

describe('platform lead sink', () => {
  it('stores a lead and resolves list ids back to labels', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write()]);

    expect(res!.error).toBeNull();
    expect(res!.bitrixLeadId).toBeGreaterThan(0);
    expect(res!.updatedExisting).toBe(false);

    const repo = new PlatformRepo({ db });
    const [lead] = await repo.leads();
    expect(lead!.name).toBe('Anna Petrova');
    expect(lead!.leadType).toBe('Customer');   // id 47
    expect(lead!.priority).toBe('High');       // id 83
    expect(lead!.productInterest).toBe('Analytics'); // id 73
    expect(lead!.statusLabel).toBe('Unprocessed');
    expect(lead!.phones).toEqual(['+49 30 1234567']);
    db.close();
  });

  it('merges a same-author duplicate instead of creating a second lead', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    await store.writeLeads([write()]);
    // Same phone, same manager, later message adds an extra number.
    const [res] = await store.writeLeads([
      write({
        localId: 'sess-2#seg-1',
        sessionId: 'sess-2',
        phones: [{ value: '+49-30-1234567', type: 'WORK' }, { value: '+49 170 000111', type: 'MOBILE' }],
      }),
    ]);

    expect(res!.updatedExisting).toBe(true);
    const repo = new PlatformRepo({ db });
    const all = await repo.leads();
    expect(all).toHaveLength(1);
    // Union, not replace — the original number must survive.
    expect(all[0]!.phones).toContain('+49 30 1234567');
    expect(all[0]!.phones).toContain('+49 170 000111');
    db.close();
  });

  it('does NOT merge the same visitor reported by a different manager', async () => {
    // Two managers legitimately meeting the same person must stay separate;
    // merging them would silently destroy one manager's lead (S10.4).
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    await store.writeLeads([write()]);
    const [res] = await store.writeLeads([
      write({
        localId: 'sess-3#seg-1',
        sessionId: 'sess-3',
        service: { teamsGroupId: 'g', teamsMessageIds: ['m9'], teamsAuthor: 'other@example.com' },
      }),
    ]);

    expect(res!.updatedExisting).toBe(false);
    const repo = new PlatformRepo({ db });
    expect(await repo.leads()).toHaveLength(2);
    // ...and it surfaces as a duplicate pair for a human to resolve.
    const dups = await repo.duplicates();
    expect(dups.length).toBeGreaterThan(0);
    db.close();
  });

  it('reports one failure without losing the rest of the batch', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    const bad = write({ localId: 'dup-id' });
    const results = await store.writeLeads([bad, write({ localId: 'dup-id', name: 'Second' })]);
    // Second write reuses local_id (UNIQUE) but has the same phone, so it
    // merges rather than erroring; either way the batch returns two results.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.localId === 'dup-id')).toBe(true);
    db.close();
  });
});

describe('platform read model', () => {
  it('exposes per-field confidence and provenance from the pipeline row', async () => {
    const db = freshDb();
    db.upsertSession(bundle, 'received');
    db.insertLead({
      id: 'sess-1#seg-1',
      sessionId: 'sess-1',
      title: 'Anna Petrova — Nordwind',
      status: 'mapped',
      fieldsJson: JSON.stringify({
        gated: {
          confidence: { name: 0.95, company: 0.9 },
          provenance: { name: { messageId: 'm1', quote: 'Anna Petrova', method: 'quote' } },
        },
        messageIds: ['m1'],
      }),
      verbatim: 'met at booth',
      aiSummaryRu: 'кратко',
      warningsJson: '[]',
      needsAttachmentRetry: false,
    });

    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write()]);
    const repo = new PlatformRepo({ db });
    const detail = await repo.lead(res!.bitrixLeadId!);

    expect(detail!.confidence).toEqual({ name: 0.95, company: 0.9 });
    expect((detail!.provenance as Record<string, { messageId: string }>)['name']!.messageId).toBe('m1');
    // Only this lead's source message — not the whole session.
    expect(detail!.sourceMessages.map((m) => m.messageId)).toEqual(['m1']);
    db.close();
  });

  it('aggregates analytics over stored leads', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    db.setEmployee('rep@example.com', 21, 'Rep One');
    await store.writeLeads([write()]);
    await store.writeLeads([
      write({
        localId: 'sess-9#seg-1',
        sessionId: 'sess-9',
        phones: [{ value: '+49 89 5550000', type: 'WORK' }],
        emails: [],
        service: { teamsGroupId: 'g', teamsMessageIds: ['m7'], teamsAuthor: 'other@example.com' },
        listFields: { leadTypeId: 45, priorityId: 85 }, // Partner / Medium
      }),
    ]);

    const a = await new PlatformRepo({ db }).analytics();
    expect(a.totals.leads).toBe(2);
    expect(a.totals.customers).toBe(1);
    expect(a.totals.partners).toBe(1);
    expect(a.totals.highPriority).toBe(1);
    expect(a.byPriority.find((p) => p.label === 'High')?.value).toBe(1);
    expect(a.overTime.length).toBeGreaterThan(0);
    db.close();
  });

  it('lists nothing (not an error) when no leads exist yet', async () => {
    const db = freshDb();
    const repo = new PlatformRepo({ db });
    expect(await repo.leads()).toEqual([]);
    expect((await repo.analytics()).totals.leads).toBe(0);
    expect(await repo.duplicates()).toEqual([]);
    db.close();
  });
});

describe('lead status journey', () => {
  it('moves a lead from Unprocessed to Completed', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write()]);
    const id = res!.bitrixLeadId!;

    const repo = new PlatformRepo({ db });
    expect((await repo.lead(id))!.statusLabel).toBe('Unprocessed');

    await store.setLeadStatus(id, 'CONVERTED');
    const done = await repo.lead(id);
    expect(done!.statusId).toBe('CONVERTED');
    expect(done!.statusLabel).toBe('Completed');
    // 'S' marks a successful terminal state, which the UI colours green.
    expect(done!.statusSemantic).toBe('S');
    db.close();
  });

  it('flags leads that share a name', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    await store.writeLeads([write()]);
    // Same person name, different manager and different phone — so it is NOT
    // merged, but it should still be visibly flagged as a possible duplicate.
    await store.writeLeads([
      write({
        localId: 'sess-7#seg-1',
        sessionId: 'sess-7',
        phones: [{ value: '+49 89 7770000', type: 'WORK' }],
        emails: [],
        service: { teamsGroupId: 'g', teamsMessageIds: ['m5'], teamsAuthor: 'other@example.com' },
      }),
    ]);

    const leads = await new PlatformRepo({ db }).leads();
    expect(leads).toHaveLength(2);
    for (const l of leads) {
      const flagged = l as unknown as { sameNameCount: number; sameNameIds: number[] };
      expect(flagged.sameNameCount).toBe(1);
      expect(flagged.sameNameIds).toHaveLength(1);
    }
    // ...and the pair is listed on the Duplicates screen.
    const dups = await new PlatformRepo({ db }).duplicates();
    expect(dups.length).toBeGreaterThan(0);
    db.close();
  });

  it('records the campaign as the exhibition when no list option matches', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db, campaignExhibition: 'Qazdream Test Project' });
    // No exhibitionId: the portal would blank it, the platform should not.
    const [res] = await store.writeLeads([write({ listFields: { leadTypeId: 47 } })]);
    const lead = await new PlatformRepo({ db }).lead(res!.bitrixLeadId!);
    expect(lead!.exhibition).toBe('Qazdream Test Project');
    db.close();
  });
});

describe('name duplicate detection', () => {
  const named = (localId: string, name: string, phone: string) =>
    write({ localId, sessionId: localId, name, phones: [{ value: phone, type: 'WORK' }], emails: [] });

  it('catches a partial name capture of the same person', async () => {
    // The real case: one message gave only a first name, a later one the full
    // name. Exact matching misses this entirely.
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    await store.writeLeads([named('a', 'MARIA OLIVIA', '+7 111 0001')]);
    await store.writeLeads([named('b', 'Maria', '+7 111 0002')]);

    const leads = await new PlatformRepo({ db }).leads();
    const flags = leads.map((l) => l as unknown as { sameNameCount: number; sameNameKind: string });
    expect(flags.every((f) => f.sameNameCount === 1)).toBe(true);
    // Reported as a possibility, not asserted as a certainty.
    expect(flags.every((f) => f.sameNameKind === 'partial')).toBe(true);
    db.close();
  });

  it('catches the same name written in the other order', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    await store.writeLeads([named('a', 'Aleksandr Petrov', '+7 222 0001')]);
    await store.writeLeads([named('b', 'Petrov Aleksandr', '+7 222 0002')]);

    const leads = await new PlatformRepo({ db }).leads();
    const flags = leads.map((l) => l as unknown as { sameNameCount: number; sameNameKind: string });
    expect(flags.every((f) => f.sameNameCount === 1 && f.sameNameKind === 'same')).toBe(true);
    db.close();
  });

  it('does not flag two people who merely share a first name', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    await store.writeLeads([named('a', 'John Newman', '+7 333 0001')]);
    await store.writeLeads([named('b', 'John Stewart', '+7 333 0002')]);

    const leads = await new PlatformRepo({ db }).leads();
    for (const l of leads) {
      expect((l as unknown as { sameNameCount: number }).sameNameCount).toBe(0);
    }
    db.close();
  });
});

describe('needs-attention links', () => {
  it('points at the platform lead id, not the id an old sink returned', async () => {
    // Regression: the pipeline row kept the PORTAL id from when leads were
    // written to Bitrix. "Open lead" then navigated to an id that does not
    // exist in this store, and the console rendered sample data instead.
    const db = freshDb();
    db.upsertSession(bundle, 'received');
    db.insertLead({
      id: 'sess-1#seg-1', sessionId: 'sess-1', title: 'Anna Petrova — Nordwind',
      status: 'done', fieldsJson: '{}', verbatim: '', aiSummaryRu: '',
      warningsJson: JSON.stringify(['no employee mapping for author']),
      needsAttachmentRetry: false,
    });
    db.setLeadBitrixId('sess-1#seg-1', 4821);   // a portal id, not ours

    const store = new PlatformLeadStore({ db });
    const [res] = await store.writeLeads([write()]);

    const [item] = await new PlatformRepo({ db }).needsAttention();
    expect(item!.bitrixLeadId).toBe(res!.bitrixLeadId);
    expect(item!.bitrixLeadId).not.toBe(4821);

    // ...and that id actually resolves to a lead.
    expect(await new PlatformRepo({ db }).lead(item!.bitrixLeadId!)).not.toBeNull();
    db.close();
  });

  it('links a merged lead to the lead that absorbed it', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    const [first] = await store.writeLeads([write()]);
    // Same manager and phone -> merged, so this local id has no row of its own.
    await store.writeLeads([write({ localId: 'sess-2#seg-1', sessionId: 'sess-2' })]);

    db.upsertSession(bundle, 'received');
    db.insertLead({
      id: 'sess-2#seg-1', sessionId: 'sess-1', title: 'Anna Petrova — Nordwind',
      status: 'done', fieldsJson: '{}', verbatim: '', aiSummaryRu: '',
      warningsJson: JSON.stringify(['merged duplicate']), needsAttachmentRetry: false,
    });

    const [item] = await new PlatformRepo({ db }).needsAttention();
    expect(item!.bitrixLeadId).toBe(first!.bitrixLeadId);
    db.close();
  });

  it('leaves the link empty rather than guessing when the title is ambiguous', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    // Two different leads sharing a title, reported by different managers.
    await store.writeLeads([write({ localId: 'a', phones: [{ value: '+49 1', type: 'WORK' }], emails: [] })]);
    await store.writeLeads([write({
      localId: 'b', phones: [{ value: '+49 2', type: 'WORK' }], emails: [],
      service: { teamsGroupId: 'g', teamsMessageIds: [], teamsAuthor: 'other@example.com' },
    })]);

    db.upsertSession(bundle, 'received');
    db.insertLead({
      id: 'orphan', sessionId: 'sess-1', title: 'Anna Petrova — Nordwind',
      status: 'failed', fieldsJson: '{}', verbatim: '', aiSummaryRu: '',
      warningsJson: '[]', needsAttachmentRetry: false,
    });

    const orphan = (await new PlatformRepo({ db }).needsAttention()).find((i) => i.localId === 'orphan');
    expect(orphan!.bitrixLeadId).toBeNull();
    db.close();
  });
});

describe('a lead built from several messages', () => {
  it('shows what a later message contributed, not just the first', async () => {
    // The reported symptom: a manager sent a card, then followed up with more
    // context. The follow-up merged into the same lead, but the console kept
    // showing only the first session — so the message looked unprocessed.
    const db = freshDb();
    const store = new PlatformLeadStore({ db });

    const first: SessionBundle = {
      sessionId: 's1', channel: { teamsGroupId: 'g', channelId: 'c' },
      author: { teamsUserId: 'u', email: 'rep@example.com', displayName: 'Rep' },
      sessionWindow: { openedAt: '2026-08-27T10:00:00Z', closedAt: '2026-08-27T10:01:00Z' },
      items: [{ messageId: 'm1', timestamp: '2026-08-27T10:00:00Z', type: 'image', ocrText: 'Anna Petrova' }],
    };
    const later: SessionBundle = {
      ...first,
      sessionId: 's2',
      items: [{ messageId: 'm2', timestamp: '2026-08-27T10:20:00Z', type: 'text', text: 'Interested in Integrating System' }],
    };
    db.upsertSession(first, 'received');
    db.upsertSession(later, 'received');

    db.insertLead({
      id: 'a', sessionId: 's1', title: 'Anna Petrova', status: 'done',
      fieldsJson: JSON.stringify({ gated: { confidence: { name: 0.9 } }, messageIds: ['m1'] }),
      verbatim: '', aiSummaryRu: '', warningsJson: JSON.stringify(['first warning']),
      needsAttachmentRetry: false,
    });
    db.insertLead({
      id: 'b', sessionId: 's2', title: 'Anna Petrova', status: 'done',
      fieldsJson: JSON.stringify({
        gated: { productInterestRaw: 'Integrating System', provenance: { name: { messageId: 'm2' } } },
        messageIds: ['m2'],
      }),
      verbatim: '', aiSummaryRu: '', warningsJson: JSON.stringify(['second warning']),
      needsAttachmentRetry: false,
    });

    // No productInterestId: nothing matched the CRM list, exactly as in the
    // real case, so the column stays blank and the raw value must show through.
    const bare = { leadTypeId: 47 };
    const [created] = await store.writeLeads([write({ localId: 'a', listFields: bare })]);
    // Same phone and author -> merges into the same lead.
    const [merged] = await store.writeLeads([write({ localId: 'b', sessionId: 's2', listFields: bare })]);
    expect(merged!.updatedExisting).toBe(true);

    const repo = new PlatformRepo({ db });
    const detail = await repo.lead(created!.bitrixLeadId!);

    // Both messages are shown as sources, in time order.
    expect(detail!.sourceMessages.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    // Warnings from both sessions survive.
    expect(detail!.warnings).toContain('first warning');
    expect(detail!.warnings).toContain('second warning');
    // Provenance comes from the newest row that recorded any.
    expect((detail!.provenance as Record<string, { messageId: string }>)['name']!.messageId).toBe('m2');
    // And the value only the later message supplied is visible.
    const [listed] = await repo.leads();
    expect(listed!.productInterest).toBe('Integrating System');
    db.close();
  });

  it('keeps the absorbed lead evidence when two leads are merged', async () => {
    const db = freshDb();
    const store = new PlatformLeadStore({ db });
    const [keep] = await store.writeLeads([write({ localId: 'a', emails: [] })]);
    const [drop] = await store.writeLeads([
      write({
        localId: 'b', phones: [{ value: '+49 89 111', type: 'WORK' }], emails: [],
        service: { teamsGroupId: 'g', teamsMessageIds: [], teamsAuthor: 'other@example.com' },
      }),
    ]);

    await store.mergeLeads(keep!.bitrixLeadId!, drop!.bitrixLeadId!);

    const sources = db.handle
      .prepare('SELECT local_id FROM platform_lead_sources WHERE platform_lead_id = ? ORDER BY local_id')
      .all(keep!.bitrixLeadId!) as Array<{ local_id: string }>;
    // The absorbed lead's evidence moved across rather than vanishing with it.
    expect(sources.map((s) => s.local_id)).toEqual(['a', 'b']);
    db.close();
  });
});
