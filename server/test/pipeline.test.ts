import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { buildMockApp } from '../src/app.js';
import type { SessionBundle, SessionItem } from '../src/contracts/index.js';
import { makeSessionId } from '../src/ingestion/sessionId.js';

const CFG = loadConfig({ BITRIX_MODE: 'mock', LLM_MODE: 'mock', MSGRAPH_MODE: 'mock', CAMPAIGN_EXHIBITION: 'Hannover Messe 2026' });

const CHANNEL = { teamsGroupId: 'g1', channelId: 'c1' };
const IVAN = { teamsUserId: 'u-ivan', email: 'ivan@example.com', displayName: 'Ivan' };
const OLGA = { teamsUserId: 'u-olga', email: 'olga@example.com', displayName: 'Olga' };

function bundle(author: typeof IVAN, items: SessionItem[]): SessionBundle {
  const ids = items.map((i) => i.messageId);
  const latest = items[items.length - 1]!.timestamp;
  return {
    sessionId: makeSessionId(ids, latest),
    channel: CHANNEL,
    author,
    sessionWindow: { openedAt: items[0]!.timestamp, closedAt: latest },
    items,
  };
}

function card(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
}

const anna = () =>
  bundle(IVAN, [
    { messageId: 'a1', timestamp: '2026-08-22T10:00:00Z', type: 'text', text: 'interested in analytics' },
    {
      messageId: 'a2',
      timestamp: '2026-08-22T10:00:30Z',
      type: 'image',
      ocrText: card({ Name: 'Anna Weber', Company: 'BMW AG', Country: 'Germany', Email: 'anna@bmw.de', Phone: '+498912345678' }),
    },
  ]);

describe('pipeline: happy path', () => {
  it('creates a lead, sets owner, posts a reply', async () => {
    const app = buildMockApp(CFG);
    app.db.setEmployee('ivan@example.com', 7, 'Ivan');
    const res = await app.pipeline.processSession(anna());

    expect(res.status).toBe('ok');
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0]!.bitrixLeadId).not.toBeNull();
    expect(res.replyText).toContain('Готово');
    expect(app.graph.postedReplies).toHaveLength(1);

    const stored = app.bitrix.allLeads();
    expect(stored[0]!.ownerId).toBe(7); // owner = author's mapped Bitrix id
    expect(stored[0]!.fields.UF_CRM_LEAD_TYPE).toBe(47); // Customer, never empty
    expect(stored[0]!.fields.COMMENTS).toContain('analytics'); // verbatim preserved
  });

  it('flags default-owner fallback when author is unmapped', async () => {
    const app = buildMockApp(CFG);
    const res = await app.pipeline.processSession(anna());
    expect(res.leads[0]!.warnings.some((w) => /default owner/.test(w))).toBe(true);
  });
});

describe('pipeline: idempotency suite (Automation metric)', () => {
  it('(a) full re-run of the same input creates 0 new leads and stays silent', async () => {
    const app = buildMockApp(CFG);
    const first = await app.pipeline.processSession(anna());
    expect(first.status).toBe('ok');
    const before = app.bitrix.allLeads().length;
    const repliesBefore = app.graph.postedReplies.length;

    const second = await app.pipeline.processSession(anna());
    expect(second.status).toBe('noop');
    expect(app.bitrix.allLeads().length).toBe(before); // no new leads
    expect(app.graph.postedReplies.length).toBe(repliesBefore); // noop is silent (S11)
  });

  it('(b) crash after write but before ledger commit does not duplicate on restart', async () => {
    const app = buildMockApp(CFG);
    await app.pipeline.processSession(anna());
    expect(app.bitrix.allLeads()).toHaveLength(1);

    // Simulate a crash that wrote the lead but never recorded the messages as
    // processed — the ledger is the source of truth, so a restart re-runs.
    app.db.handle.exec('DELETE FROM processed_messages');

    const restart = await app.pipeline.processSession(anna());
    expect(restart.status).toBe('ok');
    // Content dedup (same owner) updates the existing lead — 0 duplicates.
    expect(app.bitrix.allLeads()).toHaveLength(1);
  });

  it('(c) overlapping backfill only processes genuinely-new messages', async () => {
    const app = buildMockApp(CFG);
    await app.pipeline.processSession(anna());
    const before = app.bitrix.allLeads().length;

    // Backfill bundle overlaps a1/a2 but adds a brand-new contact message set.
    const overlap = bundle(IVAN, [
      { messageId: 'a1', timestamp: '2026-08-22T10:00:00Z', type: 'text', text: 'interested in analytics' },
      {
        messageId: 'b1',
        timestamp: '2026-08-22T10:05:00Z',
        type: 'image',
        ocrText: card({ Name: 'New Person', Company: 'NewCo', Email: 'new@co.com', Phone: '+441234567890' }),
      },
    ]);
    const res = await app.pipeline.processSession(overlap);
    expect(res.status).toBe('ok');
    expect(app.bitrix.allLeads().length).toBe(before + 1); // only the new contact
  });
});

describe('pipeline: accuracy-adjacent behaviors', () => {
  it('two managers, one visitor -> two separate leads with distinct owners (S10.4/10.5)', async () => {
    const app = buildMockApp(CFG);
    app.db.setEmployee('ivan@example.com', 7, 'Ivan');
    app.db.setEmployee('olga@example.com', 9, 'Olga');
    const commonCard = card({ Name: 'Sven Larsson', Company: 'Volvo', Email: 'sven@volvo.se', Phone: '+46812345678' });

    await app.pipeline.processSession(
      bundle(IVAN, [{ messageId: 'iv1', timestamp: '2026-08-22T10:00:00Z', type: 'image', ocrText: commonCard }]),
    );
    await app.pipeline.processSession(
      bundle(OLGA, [{ messageId: 'ol1', timestamp: '2026-08-22T10:05:00Z', type: 'image', ocrText: commonCard }]),
    );

    const leads = app.bitrix.allLeads();
    expect(leads).toHaveLength(2); // NOT merged despite identical comm
    expect(new Set(leads.map((l) => l.ownerId))).toEqual(new Set([7, 9]));
  });

  it('same-owner duplicate updates the existing lead instead of creating a new one', async () => {
    const app = buildMockApp(CFG);
    const b1 = bundle(IVAN, [{ messageId: 'd1', timestamp: '2026-08-22T10:00:00Z', type: 'image', ocrText: card({ Name: 'Dup Person', Email: 'dup@x.com', Phone: '+70000000000' }) }]);
    const b2 = bundle(IVAN, [{ messageId: 'd2', timestamp: '2026-08-22T10:05:00Z', type: 'image', ocrText: card({ Name: 'Dup Person', Email: 'dup@x.com', Phone: '+70000000000' }) }]);
    await app.pipeline.processSession(b1);
    const res2 = await app.pipeline.processSession(b2);
    expect(app.bitrix.allLeads()).toHaveLength(1); // updated, not duplicated
    expect(res2.status).toBe('ok');
  });

  it('non-lead noise produces no lead and no reply', async () => {
    const app = buildMockApp(CFG);
    const noise = bundle(OLGA, [
      { messageId: 'n1', timestamp: '2026-08-22T10:00:00Z', type: 'text', text: 'closing the booth at 6pm' },
      { messageId: 'n2', timestamp: '2026-08-22T10:00:10Z', type: 'text', text: '👍' },
    ]);
    const res = await app.pipeline.processSession(noise);
    expect(res.status).toBe('noop');
    expect(app.bitrix.allLeads()).toHaveLength(0);
    expect(app.graph.postedReplies).toHaveLength(0);
  });

  it('attachmentPending image still creates a lead, flagged for retry', async () => {
    const app = buildMockApp(CFG);
    const b = bundle(OLGA, [
      { messageId: 'p1', timestamp: '2026-08-22T10:00:00Z', type: 'text', text: 'hot lead, email fatima@adnoc.ae, wants support' },
      { messageId: 'p2', timestamp: '2026-08-22T10:00:10Z', type: 'image', ocrText: null, attachmentPending: true },
    ]);
    const res = await app.pipeline.processSession(b);
    expect(res.status).toBe('ok');
    const lead = app.db.getLeadsForSession(b.sessionId)[0]!;
    expect(lead.needs_attachment_retry).toBe(1);
  });
});
