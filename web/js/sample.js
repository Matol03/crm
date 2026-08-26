/**
 * Fallback data, used ONLY when the live service cannot be reached.
 *
 * This is not a demo mode you can browse into by accident: the console always
 * tries the real API first, and every screen that falls back here is banner-ed
 * as showing sample data. It exists so a dropped connection shows a working
 * interface instead of a wall of errors.
 *
 * Names are obviously fictional on purpose — nobody should mistake a fallback
 * for a real pipeline result.
 */

const NOW = Date.now();
const ago = (m) => new Date(NOW - m * 60000).toISOString();

const OWNER = 'Sample Manager';

function lead(id, name, company, over = {}) {
  return {
    bitrixLeadId: id,
    title: `${name} — ${company}`,
    name,
    company,
    position: 'Head of Procurement',
    owner: OWNER,
    ownerId: 1,
    statusId: 'NEW',
    statusLabel: 'Unprocessed',
    statusSemantic: 'P',
    leadType: 'Customer',
    region: 'Europe',
    productInterest: 'Analytics',
    priority: 'Medium',
    phones: [`+49 30 0000 ${id}`],
    emails: [`${name.toLowerCase().replace(/\W+/g, '.')}@example.com`],
    createdAt: ago(id),
    teamsAuthor: 'sample.manager@example.com',
    url: '#',
    fromPipeline: true,
    localId: `sample-${id}`,
    confidence: { name: 0.96, company: 0.94, position: 0.81, phones: 0.9, emails: 0.72 },
    ...over,
  };
}

export const LEADS = [
  lead(101, 'Sample Contact One', 'Example Industries'),
  lead(102, 'Sample Contact Two', 'Example Logistics', { priority: 'High', productInterest: 'Integration Services' }),
  lead(103, 'Sample Contact Three', 'Example Energy', { leadType: 'Partner', statusLabel: 'In progress', statusId: 'IN_PROCESS' }),
  lead(104, 'Sample Contact Four', 'Example Analytics', { priority: 'Low', fromPipeline: false, confidence: null }),
];

export const LEAD_DETAIL = {
  ...LEADS[0],
  verbatim: 'Sample message text preserved exactly as the manager sent it.',
  aiSummary: 'Sample generated summary. This is fallback content, not a real analysis.',
  warnings: [],
  provenance: {
    name: { messageId: 'sample-msg-1', quote: 'Sample Contact One', method: 'quote' },
    company: { messageId: 'sample-msg-1', quote: 'Example Industries', method: 'quote' },
  },
  sourceMessages: [
    {
      messageId: 'sample-msg-1', timestamp: ago(20), type: 'text',
      text: 'Sample Contact One from Example Industries, interested in analytics.',
      transcript: null, ocrText: null, author: OWNER, attachmentPending: false,
    },
  ],
};

export const ANALYTICS = {
  totals: { leads: 4, customers: 3, partners: 1, highPriority: 1 },
  byInterest: [{ label: 'Analytics', value: 3 }, { label: 'Integration Services', value: 1 }],
  byPriority: [{ label: 'Medium', value: 2 }, { label: 'High', value: 1 }, { label: 'Low', value: 1 }],
  byManager: [{ label: OWNER, value: 4 }],
  byStatus: [{ label: 'Unprocessed', value: 3 }, { label: 'In progress', value: 1 }],
  overTime: [{ label: '2026-08-22', value: 1 }, { label: '2026-08-23', value: 1 }, { label: '2026-08-24', value: 2 }],
};

export const DUPLICATES = [];
export const ATTENTION = [];

export const REFERENCE = {
  lists: {
    UF_CRM_LEAD_TYPE: { 45: 'Partner', 47: 'Customer' },
    UF_CRM_PRIORITY: { 83: 'High', 85: 'Medium', 87: 'Low' },
  },
  users: { 1: OWNER },
  statuses: { NEW: 'Unprocessed', IN_PROCESS: 'In progress' },
  campaign: { name: 'Sample Project', source: 'Trade Show' },
};

export const SYSTEM = {
  modes: { msgraph: 'mock', bitrix: 'mock', llm: 'mock', ocr: 'fixture', asr: 'mock' },
  providers: {},
  credentials: {},
  channel: {},
  campaign: REFERENCE.campaign,
  tuning: { idleTimeoutMs: 240000, maxSessionDurationMs: 900000, pollIntervalMs: 20000, confidenceThreshold: 0.6, defaultOwnerId: 1 },
  queues: { failed: 0, needsAttachmentRetry: 0, processed: 4 },
  watermark: null,
  employeeMap: [],
};

export const LOGS = {
  entries: [
    { kind: 'info', text: 'Sample log — the live service could not be reached.' },
    { kind: 'poll', count: 2, text: '[poll] 2 new message(s)' },
    { kind: 'session', author: 'sample.manager@example.com', items: 2, text: '[session] sample.manager@example.com — 2 item(s)' },
    { kind: 'result', status: 'ok', leads: 1, text: 'status=ok leads=1' },
    { kind: 'lead', title: 'Sample Contact One — Example Industries', text: '• Sample Contact One — Example Industries' },
  ],
};
