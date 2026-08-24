/**
 * Data layer.
 *
 * Every screen talks to this module and nothing else — components never call
 * `fetch` directly. Each getter returns `{ data, source }` where `source` is:
 *
 *   'live' — served by the running lead-service API
 *   'demo' — fixture data (endpoint not implemented yet, or no API secret)
 *
 * The UI surfaces that distinction rather than hiding it: a value the backend
 * does not actually record (per-field confidence, provenance) is shown as
 * "not recorded" in live mode instead of being invented. Wiring a new endpoint
 * later means changing one function here, not a component.
 */

import * as mock from './mock.js';

const SECRET_KEY = 'leadservice.apiSecret';

export const getSecret = () => sessionStorage.getItem(SECRET_KEY) || '';
export const setSecret = (v) => {
  if (v) sessionStorage.setItem(SECRET_KEY, v);
  else sessionStorage.removeItem(SECRET_KEY);
};

/** Tracks whether the last live call succeeded, for the connection indicator. */
export const connection = { live: false, checked: false, reason: '' };

/**
 * Call the real API. Resolves to `null` (never throws) when the endpoint is
 * missing, unauthorised or unreachable, so callers can fall back to fixtures.
 */
async function live(path, { method = 'GET', body } = {}) {
  const secret = getSecret();
  if (!secret) {
    connection.reason = 'No API secret';
    return null;
  }
  try {
    const res = await fetch(path, {
      method,
      headers: {
        'x-api-secret': secret,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      connection.reason = res.status === 401 ? 'Invalid API secret' : `API ${res.status}`;
      return null;
    }
    connection.live = true;
    connection.reason = '';
    return await res.json();
  } catch {
    connection.reason = 'Service unreachable';
    return null;
  }
}

/** Probe the unauthenticated health route to show connection state. */
export async function checkConnection() {
  try {
    const res = await fetch('/health');
    connection.checked = true;
    connection.live = res.ok && !!getSecret();
    if (!res.ok) connection.reason = 'Service unreachable';
    return res.ok;
  } catch {
    connection.checked = true;
    connection.live = false;
    connection.reason = 'Service unreachable';
    return false;
  }
}

const ok = (data) => ({ data, source: 'live' });
const demo = (data) => ({ data, source: 'demo' });

/* ── Normalisation ────────────────────────────────────────────────────────
   Maps the service's storage shape onto the shape the UI renders. Keeping
   this in one place is what lets the components stay backend-agnostic.
   ---------------------------------------------------------------------- */

/** Split a stored title ("Anna Weber — BMW AG") into person + company. */
function splitTitle(title = '') {
  const [name, company] = String(title).split(' — ');
  return { name: name || title || 'Untitled lead', company: company || null };
}

/** Map the backend's lead-state-machine value to a UI status. */
function uiStatus(raw, bitrixLeadId) {
  if (raw === 'done') return bitrixLeadId ? 'created' : 'processing';
  if (raw === 'failed') return 'failed';
  if (['received', 'segmented', 'extracted', 'mapped', 'dedup_checked', 'writing_crm'].includes(raw)) return 'processing';
  return raw || 'processing';
}

/** Backend list row → UI lead summary. */
function normaliseListItem(row) {
  const { name, company } = splitTitle(row.title);
  return {
    id: row.id,
    bitrixLeadId: row.bitrixLeadId ?? null,
    status: uiStatus(row.status, row.bitrixLeadId),
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    person: { name, position: null },
    company,
    country: null,
    region: null,
    owner: null,
    leadType: null,
    productInterest: null,
    priority: null,
    phones: [],
    emails: [],
    // The service does not persist per-field confidence today.
    confidence: { overall: null, fields: {} },
    warnings: [],
    needsAttachmentRetry: !!row.needsAttachmentRetry,
    sourceMessages: [],
    provenance: {},
    journal: [],
    crm: { state: row.bitrixLeadId ? 'created' : 'pending', bitrixLeadId: row.bitrixLeadId ?? null },
  };
}

/** Backend detail payload → full UI lead. */
function normaliseDetail(row) {
  const base = normaliseListItem(row);
  const gated = row.fields?.gated || {};
  const msgs = (row.sourceMessages || []).map((m, i) => ({
    id: m.messageId || `m-${i}`,
    ts: m.timestamp,
    type: m.type,
    text: m.text || null,
    transcript: m.transcript || null,
    ocrText: m.ocrText || null,
    author: null,
    attachmentPending: !!m.attachmentPending,
  }));

  return {
    ...base,
    person: { name: gated.name || base.person.name, position: gated.position || null },
    company: gated.company || base.company,
    country: gated.country || null,
    leadType: gated.leadType || null,
    productInterest: gated.productInterestRaw || null,
    priority: gated.priorityRaw || null,
    phones: gated.phones || [],
    emails: gated.emails || [],
    warnings: row.warnings || [],
    verbatim: row.verbatim || gated.verbatim || '',
    aiSummary: row.aiSummaryRu || gated.summaryRu || '',
    sourceMessages: msgs,
    journal: buildJournal(row, msgs),
    crm: {
      state: row.status === 'failed' ? 'failed' : row.bitrixLeadId ? 'created' : 'pending',
      bitrixLeadId: row.bitrixLeadId ?? null,
      retryable: row.status === 'failed',
      error: row.status === 'failed' ? 'The last CRM write did not complete.' : null,
    },
  };
}

/**
 * Derive a processing journal from what the service actually records.
 * Real per-stage timestamps are not stored, so entries are anchored to the
 * messages we do have rather than invented.
 */
function buildJournal(row, msgs) {
  const entries = msgs.map((m) => ({
    ts: m.ts,
    label: `${m.type === 'voice' ? 'Voice' : m.type === 'image' ? 'Attachment' : 'Text'} message received`,
    detail: m.attachmentPending ? 'Attachment not yet retrievable — flagged for retry' : null,
    tone: m.attachmentPending ? 'warn' : 'info',
  }));
  const last = msgs.at(-1)?.ts;
  if (row.bitrixLeadId) {
    entries.push({ ts: last, label: `Lead created #${row.bitrixLeadId}`, detail: 'Written to Bitrix24', tone: 'ok' });
  } else if (row.status === 'failed') {
    entries.push({ ts: last, label: 'CRM sync failed', detail: 'Available for resend', tone: 'danger' });
  }
  return entries;
}

/* ── Leads ───────────────────────────────────────────────────────────────── */

export async function getLeads() {
  const rows = await live('/api/leads');
  if (Array.isArray(rows) && rows.length) return ok(rows.map(normaliseListItem));
  return demo(mock.LEADS);
}

export async function getLead(id) {
  const row = await live(`/api/leads/${encodeURIComponent(id)}`);
  if (row && row.id) return ok(normaliseDetail(row));
  const found = mock.LEADS.find((l) => l.id === id);
  return found ? demo(found) : demo(null);
}

/** Re-drive a failed lead through the pipeline. Returns {ok, message}. */
export async function resendLead(id) {
  const res = await live(`/api/leads/${encodeURIComponent(id)}/resend`, { method: 'POST' });
  if (res) return { ok: true, message: 'Lead re-submitted to Bitrix24.', live: true };

  // Demo mode: simulate the retry, then actually transition the fixture so the
  // screen reflects the new state instead of snapping back to "failed".
  await new Promise((r) => setTimeout(r, 900));
  const lead = mock.LEADS.find((l) => l.id === id);
  if (lead) {
    const assignedId = lead.bitrixLeadId || 400 + mock.LEADS.indexOf(lead);
    lead.status = 'created';
    lead.bitrixLeadId = assignedId;
    lead.crm = { state: 'created', bitrixLeadId: assignedId, lastAttempt: new Date().toISOString() };
    lead.journal = [
      ...(lead.journal || []),
      { ts: new Date().toISOString(), label: `Lead created #${assignedId}`, detail: 'Retry succeeded', tone: 'ok' },
    ];
  }
  return { ok: true, message: 'Lead successfully synchronised.', live: false };
}

/* ── Screens without a backend endpoint yet ──────────────────────────────── */

export async function getDashboard() {
  const leads = await getLeads();
  if (leads.source === 'live') {
    const rows = leads.data;
    const created = rows.filter((l) => l.status === 'created').length;
    const failed = rows.filter((l) => l.status === 'failed').length;
    const processing = rows.filter((l) => l.status === 'processing').length;
    return ok({
      kpis: {
        messages: rows.reduce((n, l) => n + Math.max(1, l.sourceMessages.length), 0),
        leads: rows.length,
        review: rows.filter((l) => l.needsAttachmentRetry).length,
        errors: failed,
        duplicates: null,
        avgProcessingSec: null,
        crmSuccess: rows.length ? created / rows.length : null,
      },
      pipeline: [
        { key: 'messages', name: 'Messages', count: rows.length, note: 'ingested' },
        { key: 'grouping', name: 'Grouping', count: 0, note: 'buffering' },
        { key: 'extraction', name: 'Extraction', count: processing, note: 'in progress', active: processing > 0 },
        { key: 'validation', name: 'Validation', count: 0, note: 'confidence gate' },
        { key: 'resolution', name: 'Resolution', count: failed, note: 'needs attention' },
        { key: 'crm', name: 'CRM Sync', count: created, note: 'synced', terminal: true },
      ],
      activity: rows.slice(0, 8).map((l) => ({
        ts: l.createdAt,
        tone: l.status === 'created' ? 'ok' : l.status === 'failed' ? 'danger' : 'info',
        title: [l.person.name, l.company].filter(Boolean).join(' / '),
        note: l.status === 'created' ? 'Lead created' : l.status === 'failed' ? 'CRM sync failed' : 'Processing',
        state: l.bitrixLeadId ? `Bitrix #${l.bitrixLeadId}` : l.status === 'failed' ? 'Retryable' : 'Processing',
      })),
    });
  }
  return demo({ kpis: mock.KPIS, pipeline: mock.PIPELINE, activity: mock.ACTIVITY });
}

export async function getUnresolved() { return demo(mock.UNRESOLVED); }
export async function getDuplicates() { return demo(mock.DUPLICATES); }
export async function getAnalytics()  { return demo(mock.ANALYTICS); }
export async function getHealth()     { return demo(mock.HEALTH); }
export async function getCampaign()   { return demo(mock.CAMPAIGN); }
export async function getChannels()   { return demo(mock.CHANNELS); }
export async function getUsers()      { return demo(mock.USERS); }
export async function getIntegrations() { return demo(mock.INTEGRATIONS); }

/** Field labels used by the lead detail + evidence panel. */
export const FIELD_LABELS = {
  name: 'Name',
  company: 'Company',
  position: 'Position',
  phone: 'Phone',
  email: 'Email',
  country: 'Country',
  productInterest: 'Product interest',
  priority: 'Priority',
};
