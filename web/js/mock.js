/**
 * Realistic demo fixtures.
 *
 * These are shaped exactly like the API responses the UI expects (see
 * `api.js` for the normalised contract), so replacing a mock with a real
 * endpoint never requires touching a component.
 *
 * Everything is generated from a fixed seed, so the demo is identical on every
 * reload — no values jumping between takes.
 */

/** Deterministic PRNG (mulberry32) — stable fixtures across reloads. */
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260823);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);

/** Times are anchored to "now" so the feed always looks current. */
const NOW = Date.now();
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

export const CAMPAIGN = {
  exhibition: 'Hannover Messe 2026',
  source: 'Exhibition',
  defaultLeadType: 'customer',
  active: true,
  startsAt: '2026-08-20',
  endsAt: '2026-08-25',
  productInterests: ['Platform / Core', 'Analytics', 'Integration Services', 'Support & SLA', 'Training', 'OEM / White label'],
  priorities: ['High', 'Medium', 'Low'],
  regions: ['Europe', 'CIS', 'MENA', 'APAC', 'North America', 'LATAM', 'Africa'],
  leadTypes: ['Customer', 'Partner'],
};

const MANAGERS = [
  { name: 'Murat Askarov', email: 'm.askarov@kdtestspace.onmicrosoft.com', bitrixUserId: 21 },
  { name: 'Ivan Petrov', email: 'ivan.petrov@example.com', bitrixUserId: 7 },
  { name: 'Olga Kim', email: 'olga.kim@example.com', bitrixUserId: 9 },
  { name: 'Zhalgas Askarov', email: 'zh.askarov@kdtestspace.onmicrosoft.com', bitrixUserId: 14 },
];

const COMPANIES = [
  ['Siemens AG', 'Germany', 'Europe'], ['BMW AG', 'Germany', 'Europe'],
  ['ABB', 'Switzerland', 'Europe'], ['Airbus', 'France', 'Europe'],
  ['Enel', 'Italy', 'Europe'], ['Repsol', 'Spain', 'Europe'],
  ['Volvo', 'Sweden', 'Europe'], ['Skoda', 'Czechia', 'Europe'],
  ['Kazatomprom', 'Kazakhstan', 'CIS'], ['Rosatom', 'Russia', 'CIS'],
  ['ADNOC', 'UAE', 'MENA'], ['Saudi Aramco', 'Saudi Arabia', 'MENA'],
  ['Samsung', 'South Korea', 'APAC'], ['Toyota', 'Japan', 'APAC'],
  ['Huawei', 'China', 'APAC'], ['Infosys', 'India', 'APAC'],
  ['Acme Corp', 'USA', 'North America'], ['Microsoft', 'USA', 'North America'],
];

const FIRST = ['Anna', 'Marcus', 'Elena', 'Chen', 'Priya', 'Lucas', 'Sofia', 'Yuki', 'Omar', 'Marie', 'Hans', 'Giulia', 'Diego', 'Petra', 'Sven', 'Fatima', 'John', 'Alina'];
const LAST = ['Weber', 'Lindqvist', 'Rossi', 'Wei', 'Nair', 'Silva', 'Novak', 'Tanaka', 'Haddad', 'Dubois', 'Mueller', 'Park', 'Lopez', 'Larsson', 'Smith', 'Ivanova'];
const POSITIONS = ['CTO', 'Head of Data', 'Procurement Manager', 'IT Director', 'VP Engineering', 'Innovation Lead', 'Plant Manager', 'Digital Transformation Lead'];

/* ── The hero lead ────────────────────────────────────────────────────────
   Mirrors the worked example in the brief: a voice note, then a business card
   arriving 18 minutes later, then a text follow-up — grouped into one lead.
   This is the record the demo opens.
   ---------------------------------------------------------------------- */

const HERO = {
  id: 'lead-351',
  bitrixLeadId: 351,
  status: 'created',
  createdAt: minsAgo(38),
  updatedAt: minsAgo(35),
  person: { name: 'Aleksandr Ivanovich Petrov', position: 'CTO' },
  company: 'Siemens AG',
  country: 'Germany',
  region: 'Europe',
  owner: MANAGERS[0],
  leadType: 'customer',
  productInterest: 'Analytics',
  priority: 'High',
  phones: [{ value: '+49 170 1234567', type: 'MOBILE' }],
  emails: [{ value: 'a.petrov@siemens.com', type: 'WORK' }],
  confidence: {
    overall: 0.94,
    fields: {
      name: 0.99, company: 0.98, position: 0.91, phone: 0.88,
      email: 0.73, country: 0.99, productInterest: 0.94, priority: 0.82,
    },
  },
  warnings: ['Name differs between business card and voice note — card used (source priority).'],
  needsAttachmentRetry: false,
  verbatim:
    'Это Саша Петров из Siemens, интересуется аналитикой. Нужно срочно отправить КП до пятницы.\n' +
    'Aleksandr Ivanovich Petrov — CTO, Siemens AG, Munich, Germany\n' +
    'Send proposal by Friday.',
  aiSummary:
    'Promising technical prospect from Siemens. Interested in Analytics and integration services. ' +
    'The manager believes budget approval may land this quarter. Requested a commercial proposal by Friday.',
  sourceMessages: [
    {
      id: 'msg-a1', ts: minsAgo(58), type: 'voice', author: MANAGERS[0].name, durationSec: 42,
      transcript: 'Это Саша Петров из Siemens, интересуется аналитикой. Нужно срочно отправить КП до пятницы.',
    },
    {
      id: 'msg-a2', ts: minsAgo(40), type: 'image', author: MANAGERS[0].name,
      card: {
        name: 'Aleksandr Ivanovich Petrov', position: 'CTO', company: 'Siemens AG',
        email: 'a.petrov@siemens.com', phone: '+49 170 1234567', address: 'Munich, Germany',
      },
      ocrText: 'Aleksandr Ivanovich Petrov\nCTO\nSiemens AG\na.petrov@siemens.com\n+49 170 1234567\nMunich, Germany',
    },
    { id: 'msg-a3', ts: minsAgo(39), type: 'text', author: MANAGERS[0].name, text: 'Send proposal by Friday.' },
  ],
  /* field → where the value came from. This powers the evidence panel. */
  provenance: {
    name:            { messageId: 'msg-a2', quote: 'Aleksandr Ivanovich Petrov', note: 'Card preferred over voice ("Sasha Petrov")' },
    company:         { messageId: 'msg-a2', quote: 'Siemens AG' },
    position:        { messageId: 'msg-a2', quote: 'CTO' },
    phone:           { messageId: 'msg-a2', quote: '+49 170 1234567' },
    email:           { messageId: 'msg-a2', quote: 'a.petrov@siemens.com', note: 'Small print — verify before outreach' },
    country:         { messageId: 'msg-a2', quote: 'Munich, Germany' },
    productInterest: { messageId: 'msg-a1', quote: 'интересуется аналитикой' },
    priority:        { messageId: 'msg-a1', quote: 'Нужно срочно отправить КП до пятницы.' },
  },
  journal: [
    { ts: minsAgo(58), label: 'Message received', detail: 'Voice message, 42 s', tone: 'info' },
    { ts: minsAgo(58), label: 'Speech-to-text completed', detail: 'ru-RU · 1.9 s', tone: 'info' },
    { ts: minsAgo(57), label: 'Candidate #184 created', detail: 'New contact candidate opened', tone: 'info' },
    { ts: minsAgo(40), label: 'Attachment received', detail: 'business-card.jpg · 1.2 MB', tone: 'info' },
    { ts: minsAgo(40), label: 'OCR completed', detail: '6 fields read from card', tone: 'info' },
    { ts: minsAgo(39), label: 'Entity extraction completed', detail: '8 fields · avg confidence 91%', tone: 'info' },
    { ts: minsAgo(39), label: 'Match candidates evaluated', detail: '2 candidates · best 93%', tone: 'info' },
    { ts: minsAgo(39), label: 'Candidate #184 selected', detail: 'Grouped 3 messages into one lead', tone: 'ok' },
    { ts: minsAgo(38), label: 'Bitrix24 duplicate check', detail: 'No same-owner duplicate found', tone: 'info' },
    { ts: minsAgo(38), label: 'Lead created #351', detail: 'Owner: Murat Askarov', tone: 'ok' },
  ],
  crm: { state: 'created', bitrixLeadId: 351, lastAttempt: minsAgo(38) },
};

/* A failed-sync lead so the retry UX (PRD §14) is demonstrable. */
const FAILED = {
  id: 'lead-372',
  bitrixLeadId: null,
  status: 'failed',
  createdAt: minsAgo(22),
  updatedAt: minsAgo(19),
  person: { name: 'Marcus Lindqvist', position: 'Procurement Manager' },
  company: 'Volvo',
  country: 'Sweden',
  region: 'Europe',
  owner: MANAGERS[2],
  leadType: 'customer',
  productInterest: 'Integration Services',
  priority: 'Medium',
  phones: [{ value: '+46 8 123 4567', type: 'WORK' }],
  emails: [{ value: 'm.lindqvist@volvo.se', type: 'WORK' }],
  confidence: { overall: 0.88, fields: { name: 0.96, company: 0.97, position: 0.84, phone: 0.9, email: 0.86, country: 0.95, productInterest: 0.79, priority: 0.66 } },
  warnings: [],
  needsAttachmentRetry: false,
  verbatim: 'Marcus Lindqvist, Volvo, procurement. Wants integration services, follow up next week.',
  aiSummary: 'Procurement contact at Volvo evaluating integration services. Follow-up expected next week; no urgency signalled.',
  sourceMessages: [
    { id: 'msg-f1', ts: minsAgo(24), type: 'text', author: MANAGERS[2].name, text: 'Marcus Lindqvist, Volvo, procurement. Wants integration services, follow up next week. m.lindqvist@volvo.se, +46 8 123 4567' },
  ],
  provenance: {
    name: { messageId: 'msg-f1', quote: 'Marcus Lindqvist' },
    company: { messageId: 'msg-f1', quote: 'Volvo' },
    position: { messageId: 'msg-f1', quote: 'procurement' },
    email: { messageId: 'msg-f1', quote: 'm.lindqvist@volvo.se' },
    phone: { messageId: 'msg-f1', quote: '+46 8 123 4567' },
    productInterest: { messageId: 'msg-f1', quote: 'Wants integration services' },
  },
  journal: [
    { ts: minsAgo(24), label: 'Message received', detail: 'Text message', tone: 'info' },
    { ts: minsAgo(23), label: 'Entity extraction completed', detail: '6 fields · avg confidence 88%', tone: 'info' },
    { ts: minsAgo(22), label: 'Candidate resolved', detail: 'Single contact', tone: 'ok' },
    { ts: minsAgo(19), label: 'Bitrix24 sync failed', detail: 'Request timed out after 30 s', tone: 'danger' },
  ],
  crm: {
    state: 'failed',
    error: 'Bitrix24 request timed out.',
    retryable: true,
    attempts: 2,
    lastAttempt: minsAgo(19),
  },
};

/* ── Generated leads (volume for the table) ──────────────────────────────── */

function makeLead(i) {
  const [company, country, region] = pick(COMPANIES);
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const owner = pick(MANAGERS);
  const overall = between(0.62, 0.99);
  const statusRoll = rand();
  const status =
    statusRoll > 0.9 ? 'needs_review' :
    statusRoll > 0.86 ? 'processing' :
    statusRoll > 0.83 ? 'duplicate' : 'created';
  const createdAt = minsAgo(Math.round(between(45, 2600)));
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
  const domain = company.toLowerCase().replace(/[^a-z]+/g, '') + '.com';

  const jitter = (base) => Math.max(0.45, Math.min(0.995, base + between(-0.12, 0.06)));
  return {
    id: `lead-${200 + i}`,
    bitrixLeadId: status === 'created' ? 300 + i : null,
    status,
    createdAt,
    updatedAt: createdAt,
    person: { name, position: pick(POSITIONS) },
    company, country, region,
    owner,
    leadType: rand() > 0.74 ? 'partner' : 'customer',
    productInterest: pick(CAMPAIGN.productInterests),
    priority: rand() > 0.78 ? 'High' : rand() > 0.4 ? 'Medium' : 'Low',
    phones: [{ value: '+49 170 ' + Math.floor(between(100000, 999999)), type: 'MOBILE' }],
    emails: rand() > 0.12 ? [{ value: `${slug}@${domain}`, type: 'WORK' }] : [],
    confidence: {
      overall,
      fields: {
        name: jitter(overall), company: jitter(overall), position: jitter(overall - 0.05),
        phone: jitter(overall - 0.03), email: jitter(overall - 0.1), country: jitter(overall),
        productInterest: jitter(overall - 0.04), priority: jitter(overall - 0.14),
      },
    },
    warnings: overall < 0.75 ? ['Some fields fell below the confidence threshold and were left blank.'] : [],
    needsAttachmentRetry: rand() > 0.93,
    verbatim: `${name} from ${company}. ${pick(['Interested in analytics.', 'Wants a platform demo.', 'Asked about pricing.', 'Requesting a proposal.'])}`,
    aiSummary: `${pick(POSITIONS)} at ${company} exploring ${pick(CAMPAIGN.productInterests)}. ${pick(['Follow-up agreed.', 'Budget not confirmed.', 'Decision expected next quarter.', 'Wants a technical deep-dive.'])}`,
    sourceMessages: [
      { id: `msg-${i}-1`, ts: createdAt, type: pick(['text', 'voice', 'image']), author: owner.name, text: `${name}, ${company}`, transcript: `${name} from ${company}`, ocrText: `${name}\n${company}` },
    ],
    provenance: { name: { messageId: `msg-${i}-1`, quote: name }, company: { messageId: `msg-${i}-1`, quote: company } },
    journal: [
      { ts: createdAt, label: 'Message received', tone: 'info' },
      { ts: createdAt, label: 'Entity extraction completed', tone: 'info' },
      { ts: createdAt, label: status === 'created' ? 'Lead created' : 'Awaiting review', tone: status === 'created' ? 'ok' : 'warn' },
    ],
    crm: status === 'created' ? { state: 'created', bitrixLeadId: 300 + i } : { state: 'pending' },
  };
}

export const LEADS = [HERO, FAILED, ...Array.from({ length: 34 }, (_, i) => makeLead(i))];

/* ── Unresolved candidates ───────────────────────────────────────────────── */

export const UNRESOLVED = [
  {
    id: 'cand-184', label: 'Candidate #184',
    name: 'Aleksandr', company: 'Siemens',
    confidence: 0.71,
    lastEvidence: 'Business card', lastEvidenceAt: minsAgo(12),
    owner: MANAGERS[0],
    reason: 'Name matches two existing leads at the same company.',
    messages: 2,
    matches: [
      { id: 'lead-184', label: '#184 Siemens AG', person: 'Aleksandr Ivanovich Petrov', score: 0.93 },
      { id: 'lead-191', label: '#191 Siemens', person: 'Alexander Petrov', score: 0.54 },
    ],
    evidence: [
      { type: 'image', ts: minsAgo(12), quote: 'Aleksandr Petrov\nSiemens\n+49 170 1234567' },
      { type: 'voice', ts: minsAgo(26), quote: 'Ещё один контакт из Siemens, кажется тот же человек.' },
    ],
  },
  {
    id: 'cand-190', label: 'Candidate #190',
    name: 'M. Garcia', company: 'ABB',
    confidence: 0.58,
    lastEvidence: 'Voice message', lastEvidenceAt: minsAgo(31),
    owner: MANAGERS[1],
    reason: 'Only a surname and company were recognised — no contact channel.',
    messages: 1,
    matches: [{ id: 'lead-207', label: '#207 ABB', person: 'Maria Garcia', score: 0.61 }],
    evidence: [{ type: 'voice', ts: minsAgo(31), quote: 'Говорил с Гарсия из ABB, визитку не дали.' }],
  },
  {
    id: 'cand-193', label: 'Candidate #193',
    name: 'Unknown', company: 'Toyota',
    confidence: 0.44,
    lastEvidence: 'Photo (unreadable)', lastEvidenceAt: minsAgo(48),
    owner: MANAGERS[3],
    reason: 'Business card could not be read and no other identifying data was provided.',
    messages: 1,
    matches: [],
    evidence: [{ type: 'image', ts: minsAgo(48), quote: 'Attachment could not be decoded (corrupted file).' }],
  },
];

/* ── Duplicate pairs ─────────────────────────────────────────────────────── */

export const DUPLICATES = [
  {
    id: 'dup-1',
    similarity: 0.94,
    detectedAt: minsAgo(16),
    left:  { id: 'lead-182', bitrixLeadId: 182, name: 'Aleksandr Petrov', company: 'Siemens AG', position: 'CTO', phone: '+49 170 1234567', email: 'a.petrov@siemens.com', owner: MANAGERS[0], createdAt: minsAgo(120) },
    right: { id: 'lead-193', bitrixLeadId: 193, name: 'Alexander Petrov', company: 'Siemens',    position: 'CTO', phone: '+49 170 1234567', email: 'a.petrov@siemens.com', owner: MANAGERS[0], createdAt: minsAgo(16) },
    signals: [
      { label: 'Same normalised phone', match: true },
      { label: 'Same company', match: true },
      { label: 'Similar name', match: true },
      { label: 'Same position', match: true },
      { label: 'Same owner', match: true },
    ],
  },
  {
    id: 'dup-2',
    similarity: 0.61,
    detectedAt: minsAgo(74),
    left:  { id: 'lead-201', bitrixLeadId: 201, name: 'Sven Larsson', company: 'Volvo', position: 'Plant Manager', phone: '+46 8 123 4567', email: 'sven.larsson@volvo.se', owner: MANAGERS[1], createdAt: minsAgo(200) },
    right: { id: 'lead-214', bitrixLeadId: 214, name: 'Sven Larsson', company: 'Volvo', position: 'Head of Data',  phone: '+46 70 998 1122', email: 'sven.larsson@volvo.se', owner: MANAGERS[2], createdAt: minsAgo(74) },
    signals: [
      { label: 'Same email', match: true },
      { label: 'Same company', match: true },
      { label: 'Same name', match: true },
      { label: 'Same normalised phone', match: false },
      { label: 'Same owner', match: false },
    ],
    note: 'Different managers met this visitor — two separate leads is the expected outcome.',
  },
];

/* ── Live activity feed ──────────────────────────────────────────────────── */

export const ACTIVITY = [
  { ts: minsAgo(1),  tone: 'info',   title: 'Aleksandr Petrov / Siemens', note: 'Extracting business card…', state: 'Processing' },
  { ts: minsAgo(2),  tone: 'ok',     title: 'Maria Garcia / ABB',          note: 'Lead created',              state: 'Bitrix #381' },
  { ts: minsAgo(3),  tone: 'warn',   title: 'John Smith / Microsoft',      note: 'Possible duplicate',        state: 'Needs review' },
  { ts: minsAgo(6),  tone: 'ok',     title: 'Priya Nair / Infosys',        note: 'Lead created',              state: 'Bitrix #380' },
  { ts: minsAgo(9),  tone: 'info',   title: 'Voice message received',      note: 'Transcribing (ru-RU)…',     state: 'Processing' },
  { ts: minsAgo(12), tone: 'danger', title: 'Marcus Lindqvist / Volvo',    note: 'CRM sync failed — timeout', state: 'Retryable' },
  { ts: minsAgo(15), tone: 'ok',     title: 'Chen Wei / Huawei',           note: 'Lead created',              state: 'Bitrix #379' },
];

/* ── Pipeline + KPIs ─────────────────────────────────────────────────────── */

export const PIPELINE = [
  { key: 'messages',   name: 'Messages',   count: 247, note: 'ingested today' },
  { key: 'grouping',   name: 'Grouping',   count: 12,  note: 'buffering' },
  { key: 'extraction', name: 'Extraction', count: 4,   note: 'in progress', active: true },
  { key: 'validation', name: 'Validation', count: 3,   note: 'confidence gate' },
  { key: 'resolution', name: 'Resolution', count: 4,   note: 'awaiting review' },
  { key: 'crm',        name: 'CRM Sync',   count: 247, note: 'synced', terminal: true },
];

export const KPIS = {
  messages: 247, leads: 38, review: 4, errors: 1,
  duplicates: 12, avgProcessingSec: 41, crmSuccess: 0.984,
  messagesDelta: '+18', leadsDelta: '+6', crmDelta: '+0.4pp',
};

/* ── Analytics ───────────────────────────────────────────────────────────── */

export const ANALYTICS = {
  totals: { leads: 247, customers: 181, partners: 66, highPriority: 42 },
  quality: [
    { label: 'Field extraction', value: 0.964 },
    { label: 'CRM success', value: 0.984 },
    { label: 'Duplicate detection', value: 0.912 },
    { label: 'Manual review', value: 0.031, invert: true },
  ],
  overTime: [
    { label: 'Day 1', customers: 22, partners: 8 },
    { label: 'Day 2', customers: 41, partners: 14 },
    { label: 'Day 3', customers: 58, partners: 19 },
    { label: 'Day 4', customers: 37, partners: 15 },
    { label: 'Day 5', customers: 23, partners: 10 },
  ],
  byInterest: [
    { label: 'Analytics', value: 71 },
    { label: 'Integration Services', value: 58 },
    { label: 'Platform / Core', value: 44 },
    { label: 'Support & SLA', value: 31 },
    { label: 'Training', value: 24 },
    { label: 'OEM / White label', value: 19 },
  ],
  byPriority: [
    { label: 'High', value: 42, tone: 'danger' },
    { label: 'Medium', value: 138, tone: 'warn' },
    { label: 'Low', value: 67, tone: 'neutral' },
  ],
  byManager: [
    { label: 'Murat Askarov', value: 84 },
    { label: 'Ivan Petrov', value: 66 },
    { label: 'Olga Kim', value: 58 },
    { label: 'Zhalgas Askarov', value: 39 },
  ],
  latency: [
    { label: 'p50', value: 34, unit: 's' },
    { label: 'p90', value: 61, unit: 's' },
    { label: 'p99', value: 96, unit: 's' },
  ],
  rates: { duplicate: 0.049, review: 0.031 },
};

/* ── Admin ───────────────────────────────────────────────────────────────── */

export const CHANNELS = [
  { id: 'ch-1', channel: '#hannover-messe', team: 'Kazdream Test WorkSpace', campaign: 'Hannover Messe 2026', active: true, messages: 247, lastMessageAt: minsAgo(1) },
  { id: 'ch-2', channel: '#gitex-global',   team: 'Kazdream Test WorkSpace', campaign: 'GITEX Global 2026',   active: true, messages: 0,   lastMessageAt: null },
  { id: 'ch-3', channel: '#adipec',         team: 'Kazdream Test WorkSpace', campaign: 'ADIPEC 2026',         active: false, messages: 118, lastMessageAt: minsAgo(60 * 24 * 40) },
];

export const USERS = MANAGERS.map((m, i) => ({
  ...m,
  role: i === 0 ? 'Administrator' : 'User',
  mapped: i !== 3,
  leads: [84, 66, 58, 39][i],
}));

export const HEALTH = {
  services: [
    { name: 'Microsoft Teams', state: 'ok', note: 'Polling every 20 s' },
    { name: 'SharePoint (attachments)', state: 'warn', note: 'Files.Read.All not granted — attachments deferred' },
    { name: 'OCR (vision)', state: 'ok', note: 'gemini-3.6-flash' },
    { name: 'Speech-to-text', state: 'ok', note: 'Fixture transcripts' },
    { name: 'AI extraction', state: 'ok', note: 'gemini-3.6-flash' },
    { name: 'Bitrix24', state: 'ok', note: 'CRM scope active' },
    { name: 'Database', state: 'ok', note: 'SQLite · 12.4 MB' },
  ],
  queues: { processing: 0, failed: 1, retry: 0 },
  quota: { used: 14, limit: 20, label: 'LLM requests today (free tier)' },
};

export const INTEGRATIONS = [
  { name: 'Microsoft Graph', status: 'connected', detail: 'App-only · ChannelMessage.Read.All, User.Read.All', warn: 'Files.Read.All and ChannelMessage.Send not granted' },
  { name: 'Bitrix24 REST', status: 'connected', detail: 'Inbound webhook · CRM scope' },
  { name: 'Gemini', status: 'connected', detail: 'gemini-3.6-flash · extraction, segmentation, OCR' },
  { name: 'DeepSeek', status: 'disabled', detail: 'Alternate provider · account has no balance' },
];
