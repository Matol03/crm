/**
 * Synthetic reference dataset generator (PRD Section 14).
 *
 * Produces two artifacts together:
 *   1. fixtures/scenarios/*.json — SessionBundles in the exact Section-4 shape.
 *   2. fixtures/ground-truth.json — which sessions are leads/non-leads, expected
 *      counts, and key field expectations, for automated scoring.
 *
 * Deterministic by construction: fixed timestamps, no randomness, sessionIds
 * derived from messageIds — so regenerating never churns the dataset and the
 * self-consistency metrics (Section 14 caveat) are reproducible.
 *
 * NOTE (Stage 1): this is the skeleton covering the required scenario *classes*
 * (~12 sessions). It is structured to expand toward the ~60-message / 20–25-lead
 * target in Section 14 by appending to SCENARIOS.
 */

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionBundle, SessionItem } from '../server/src/contracts/index.js';
import { makeSessionId } from '../server/src/ingestion/sessionId.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCEN_DIR = resolve(ROOT, 'fixtures/scenarios');
const GT_PATH = resolve(ROOT, 'fixtures/ground-truth.json');

const BASE = Date.parse('2026-08-22T10:00:00Z');
const min = (n: number) => new Date(BASE + n * 60_000).toISOString();
const sec = (n: number) => new Date(BASE + n * 1_000).toISOString();

interface GtLead {
  name?: string;
  company?: string;
  leadType?: 'customer' | 'partner';
  hasEmail?: boolean;
  hasPhone?: boolean;
}
interface GtSession {
  name: string;
  sessionId: string;
  author: string;
  expectedLeadCount: number;
  isNonLead: boolean;
  note: string;
  leads: GtLead[];
}

interface Author {
  teamsUserId: string;
  email: string;
  displayName: string;
}
const MANAGER1: Author = { teamsUserId: 'u-ivan', email: 'ivan@example.com', displayName: 'Ivan Petrov' };
const MANAGER2: Author = { teamsUserId: 'u-olga', email: 'olga@example.com', displayName: 'Olga Kim' };

const CHANNEL = { teamsGroupId: 'group-1', channelId: 'channel-1' };

function bundle(author: Author, items: SessionItem[]): SessionBundle {
  const sorted = [...items].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const ids = sorted.map((i) => i.messageId);
  const latest = sorted[sorted.length - 1]!.timestamp;
  const earliest = sorted[0]!.timestamp;
  return {
    sessionId: makeSessionId(ids, latest),
    channel: CHANNEL,
    author,
    sessionWindow: { openedAt: earliest, closedAt: latest },
    items: sorted,
  };
}

function card(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

interface Scenario {
  name: string;
  note: string;
  bundle: SessionBundle;
  expected: Omit<GtSession, 'sessionId' | 'name' | 'author'>;
}

const SCENARIOS: Scenario[] = [];

// 1. text-first then card — one clear customer lead.
{
  const items: SessionItem[] = [
    { messageId: 'm1-1', timestamp: min(0), type: 'text', text: 'Met a great prospect, interested in analytics.' },
    {
      messageId: 'm1-2',
      timestamp: min(1),
      type: 'image',
      ocrText: card({ Name: 'Anna Weber', Company: 'BMW AG', Position: 'Head of Data', Country: 'Germany', Email: 'anna.weber@bmw.de', Phone: '+498912345678' }),
      mediaUrl: 'https://mock/card1.png',
    },
  ];
  SCENARIOS.push({
    name: 'text-first-then-card',
    note: 'Ordering: text before photo; one customer lead.',
    bundle: bundle(MANAGER1, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: '', leads: [{ name: 'Anna Weber', company: 'BMW AG', leadType: 'customer', hasEmail: true, hasPhone: true }] },
  });
}

// 2. card-first then voice, with a name mismatch (card vs voice).
{
  const items: SessionItem[] = [
    {
      messageId: 'm2-1',
      timestamp: sec(0),
      type: 'image',
      ocrText: card({ Name: 'Aleksandr Ivanovich Petrov', Company: 'Siemens AG', Position: 'CTO', Country: 'Germany', Email: 'a.petrov@siemens.com', Phone: '+491701234567' }),
      mediaUrl: 'https://mock/card2.png',
    },
    { messageId: 'm2-2', timestamp: sec(30), type: 'voice', transcript: 'This is Sasha Petrov from Siemens, wants integration services, call back Monday, urgent.', mediaUrl: 'https://mock/voice2.ogg' },
  ];
  SCENARIOS.push({
    name: 'card-first-then-voice-name-mismatch',
    note: 'Card says Aleksandr Ivanovich Petrov, voice says Sasha Petrov; card wins.',
    bundle: bundle(MANAGER1, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: 'name conflict card>voice', leads: [{ name: 'Aleksandr Ivanovich Petrov', company: 'Siemens AG', leadType: 'customer', hasEmail: true, hasPhone: true }] },
  });
}

// 3. adversarial: three distinct contacts back-to-back within ~40s, no pause.
{
  const items: SessionItem[] = [
    { messageId: 'm3-1', timestamp: sec(0), type: 'image', ocrText: card({ Name: 'John Smith', Company: 'Acme Corp', Country: 'USA', Email: 'john@acme.com', Phone: '+12025550101' }), mediaUrl: 'https://mock/card3a.png' },
    { messageId: 'm3-2', timestamp: sec(15), type: 'image', ocrText: card({ Name: 'Marie Dubois', Company: 'Airbus', Country: 'France', Email: 'marie@airbus.com', Phone: '+33123456789' }), mediaUrl: 'https://mock/card3b.png' },
    { messageId: 'm3-3', timestamp: sec(38), type: 'image', ocrText: card({ Name: 'Chen Wei', Company: 'Huawei', Country: 'China', Email: 'chen@huawei.com', Phone: '+8613800000000' }), mediaUrl: 'https://mock/card3c.png' },
  ];
  SCENARIOS.push({
    name: 'three-contacts-back-to-back',
    note: 'No pause, three cards -> must be three separate leads.',
    bundle: bundle(MANAGER1, items),
    expected: {
      expectedLeadCount: 3,
      isNonLead: false,
      note: 'segmentation stress test',
      leads: [
        { name: 'John Smith', company: 'Acme Corp' },
        { name: 'Marie Dubois', company: 'Airbus' },
        { name: 'Chen Wei', company: 'Huawei' },
      ],
    },
  });
}

// 4. voice-only, no business card.
{
  const items: SessionItem[] = [
    { messageId: 'm4-1', timestamp: min(0), type: 'voice', transcript: 'Name is David Cohen, company Fintech Ltd, email david@fintech.io, wants a platform demo, medium priority.', mediaUrl: 'https://mock/voice4.ogg' },
  ];
  SCENARIOS.push({
    name: 'voice-only-no-card',
    note: 'Voice-only contact.',
    bundle: bundle(MANAGER2, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: '', leads: [{ hasEmail: true }] },
  });
}

// 5. card-only, zero commentary.
{
  const items: SessionItem[] = [
    { messageId: 'm5-1', timestamp: min(0), type: 'image', ocrText: card({ Name: 'Yuki Tanaka', Company: 'Sony', Position: 'Engineer', Country: 'Japan', Email: 'yuki@sony.jp', Phone: '+81312345678' }), mediaUrl: 'https://mock/card5.png' },
  ];
  SCENARIOS.push({
    name: 'card-only-no-comment',
    note: 'Card with no accompanying text/voice.',
    bundle: bundle(MANAGER2, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: '', leads: [{ name: 'Yuki Tanaka', company: 'Sony', hasEmail: true, hasPhone: true }] },
  });
}

// 6. same-author clarification appended to their own contact.
{
  const items: SessionItem[] = [
    { messageId: 'm6-1', timestamp: min(0), type: 'image', ocrText: card({ Name: 'Priya Nair', Company: 'Infosys', Country: 'India', Email: 'priya@infosys.com', Phone: '+919812345678' }), mediaUrl: 'https://mock/card6.png' },
    { messageId: 'm6-2', timestamp: min(2), type: 'text', text: 'Forgot to mention — she wants a quote by Friday, high priority, integration services.' },
  ];
  SCENARIOS.push({
    name: 'same-author-clarification',
    note: 'Same author adds detail to their own still-open session.',
    bundle: bundle(MANAGER1, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: '', leads: [{ name: 'Priya Nair', company: 'Infosys', hasEmail: true, hasPhone: true }] },
  });
}

// 7. partner / reseller lexical marker -> Partner.
{
  const items: SessionItem[] = [
    { messageId: 'm7-1', timestamp: min(0), type: 'image', ocrText: card({ Name: 'Carlos Mendez', Company: 'DistribuTech', Country: 'Spain', Email: 'carlos@distributech.es', Phone: '+34911223344' }), mediaUrl: 'https://mock/card7.png' },
    { messageId: 'm7-2', timestamp: min(1), type: 'text', text: 'They want to become a reseller / distributor for our platform in Iberia.' },
  ];
  SCENARIOS.push({
    name: 'partner-reseller',
    note: 'Explicit reseller/distributor markers -> Partner.',
    bundle: bundle(MANAGER1, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: 'partner double-check', leads: [{ name: 'Carlos Mendez', company: 'DistribuTech', leadType: 'partner' }] },
  });
}

// 8. pure organizational / non-lead noise.
{
  const items: SessionItem[] = [
    { messageId: 'm8-1', timestamp: min(0), type: 'text', text: 'Closing the booth at 6pm, great day everyone!' },
    { messageId: 'm8-2', timestamp: min(1), type: 'text', text: '👍' },
  ];
  SCENARIOS.push({
    name: 'non-lead-noise',
    note: 'Organizational chatter + emoji -> no lead.',
    bundle: bundle(MANAGER2, items),
    expected: { expectedLeadCount: 0, isNonLead: true, note: 'must produce no lead', leads: [] },
  });
}

// 9a + 9b. One visitor, two different managers -> two separate leads (S10.4).
{
  const commonCard = (author: string) =>
    card({ Name: 'Sven Larsson', Company: 'Volvo', Country: 'Sweden', Email: 'sven.larsson@volvo.se', Phone: '+46812345678' }) + `\nMet by: ${author}`;
  const a: SessionItem[] = [
    { messageId: 'm9a-1', timestamp: min(0), type: 'image', ocrText: commonCard('Ivan'), mediaUrl: 'https://mock/card9a.png' },
    { messageId: 'm9a-2', timestamp: min(1), type: 'text', text: 'Interested in analytics.' },
  ];
  const b: SessionItem[] = [
    { messageId: 'm9b-1', timestamp: min(5), type: 'image', ocrText: commonCard('Olga'), mediaUrl: 'https://mock/card9b.png' },
    { messageId: 'm9b-2', timestamp: min(6), type: 'text', text: 'Wants a platform demo.' },
  ];
  SCENARIOS.push({
    name: 'two-managers-one-visitor-A',
    note: 'Same visitor, manager Ivan — separate lead, owner Ivan.',
    bundle: bundle(MANAGER1, a),
    expected: { expectedLeadCount: 1, isNonLead: false, note: 'must NOT merge with B', leads: [{ name: 'Sven Larsson', company: 'Volvo' }] },
  });
  SCENARIOS.push({
    name: 'two-managers-one-visitor-B',
    note: 'Same visitor, manager Olga — separate lead, owner Olga.',
    bundle: bundle(MANAGER2, b),
    expected: { expectedLeadCount: 1, isNonLead: false, note: 'must NOT merge with A', leads: [{ name: 'Sven Larsson', company: 'Volvo' }] },
  });
}

// 10. delayed attachment (attachmentPending) -> lead created, retry flagged.
{
  const items: SessionItem[] = [
    { messageId: 'm10-1', timestamp: min(0), type: 'text', text: 'Hot lead: Fatima Al-Sayed, ADNOC, wants support & SLA, email fatima@adnoc.ae' },
    { messageId: 'm10-2', timestamp: min(0.2), type: 'image', ocrText: null, attachmentPending: true, mediaUrl: 'https://mock/card10.png' },
  ];
  SCENARIOS.push({
    name: 'attachment-pending',
    note: 'Attachment not yet retrievable; lead created and flagged for retry.',
    bundle: bundle(MANAGER2, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: 'needsAttachmentRetry', leads: [{ hasEmail: true }] },
  });
}

// 11. forwarded message with its own attachment — forwarder is the owner.
{
  const items: SessionItem[] = [
    { messageId: 'm11-1', timestamp: min(0), type: 'text', text: 'Fwd: contact from partner booth' },
    { messageId: 'm11-2', timestamp: min(0), type: 'image', ocrText: card({ Name: 'Lucas Rossi', Company: 'Enel', Country: 'Italy', Email: 'lucas@enel.it', Phone: '+390612345678' }), mediaUrl: 'https://mock/card11.png' },
  ];
  SCENARIOS.push({
    name: 'forwarded-message',
    note: 'Forwarded content; owner = forwarder (Olga).',
    bundle: bundle(MANAGER2, items),
    expected: { expectedLeadCount: 1, isNonLead: false, note: '', leads: [{ name: 'Lucas Rossi', company: 'Enel', hasEmail: true, hasPhone: true }] },
  });
}

function main(): void {
  rmSync(SCEN_DIR, { recursive: true, force: true });
  mkdirSync(SCEN_DIR, { recursive: true });

  const gt: GtSession[] = [];
  for (const s of SCENARIOS) {
    writeFileSync(resolve(SCEN_DIR, `${s.name}.json`), JSON.stringify(s.bundle, null, 2));
    gt.push({
      name: s.name,
      sessionId: s.bundle.sessionId,
      author: s.bundle.author.email,
      ...s.expected,
    });
  }

  const totalLeads = gt.reduce((n, g) => n + g.expectedLeadCount, 0);
  writeFileSync(
    GT_PATH,
    JSON.stringify(
      {
        generatedFrom: 'scripts/generate-fixtures.ts',
        caveat:
          'Self-authored fixtures — metrics are a self-consistency check on pipeline mechanics (segmentation, idempotency, mapping), NOT independent extraction validation (PRD Section 14).',
        sessionCount: gt.length,
        totalExpectedLeads: totalLeads,
        sessions: gt,
      },
      null,
      2,
    ),
  );

  console.log(`Generated ${SCENARIOS.length} scenarios -> ${SCEN_DIR}`);
  console.log(`Ground truth: ${gt.length} sessions, ${totalLeads} expected leads -> ${GT_PATH}`);
}

main();
