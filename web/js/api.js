/**
 * Data layer — every screen reads through this module and nothing else.
 *
 * There are no fixtures. All data comes from the running service:
 *
 *   Bitrix24  -> the leads themselves, statuses, owners, list values
 *   local DB  -> the AI metadata Bitrix does not store: per-field confidence,
 *                provenance, the source Teams messages, verbatim and summary
 *
 * The service merges the two and this module reshapes the result for the UI.
 * When the console has no API secret, or the service cannot reach the portal,
 * screens say so rather than showing invented numbers.
 */

import * as sample from './sample.js';

const SECRET_KEY = 'leadservice.apiSecret';

/**
 * Whether the last read came from the live service or the fallback fixtures.
 * The shell surfaces this, so sample data is never mistaken for real data.
 */
export const dataSource = { mode: 'live', reason: '' };

export const getSecret = () => sessionStorage.getItem(SECRET_KEY) || '';
export const setSecret = (v) => {
  if (v) sessionStorage.setItem(SECRET_KEY, v);
  else sessionStorage.removeItem(SECRET_KEY);
};

/**
 * Reflects the last call, for the header indicator.
 *
 * `service` distinguishes three very different situations that all used to read
 * as "unreachable":
 *   'present'     — a lead service is answering at this address
 *   'absent'      — the host serves the files but has no service behind them
 *                   (a static copy, e.g. on Vercel); no secret can ever work
 *   'unreachable' — nothing answered at all (offline, or the service is down)
 */
export const connection = { live: false, checked: false, reason: '', service: 'unknown' };

/** Thrown for any condition a screen should explain rather than crash on. */
export class ApiError extends Error {
  constructor(message, { kind = 'error' } = {}) {
    super(message);
    this.kind = kind;   // 'auth' | 'crm' | 'network' | 'error'
  }
}

async function call(path) {
  const secret = getSecret();
  if (!secret) {
    connection.live = false;
    connection.reason = 'No API secret';
    throw new ApiError('This console needs the API secret before it can read anything.', { kind: 'auth' });
  }
  let res;
  try {
    res = await fetch(path, { headers: { 'x-api-secret': secret } });
  } catch {
    connection.live = false;
    connection.reason = 'Service unreachable';
    throw new ApiError('The lead service is not responding.', { kind: 'network' });
  }
  if (res.status === 401) {
    connection.live = false;
    connection.reason = 'Invalid API secret';
    throw new ApiError('That API secret was rejected.', { kind: 'auth' });
  }
  if (res.status === 503) {
    connection.live = false;
    connection.reason = 'CRM not configured';
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || 'No lead store is configured.', { kind: 'crm' });
  }
  if (res.status === 404) {
    // The page loaded but the API route does not exist — this is a static-only
    // deployment (e.g. Vercel), which cannot run the poller or reach Bitrix24.
    connection.live = false;
    connection.reason = 'No service behind this page';
    throw new ApiError(
      'This page is being served without the lead service behind it, so there is no data to read.',
      { kind: 'no-service' },
    );
  }
  if (!res.ok) {
    connection.reason = `API ${res.status}`;
    throw new ApiError(`The service returned an unexpected response (${res.status}).`);
  }
  connection.live = true;
  connection.reason = '';
  return res.json();
}

export async function checkConnection() {
  try {
    const res = await fetch('/health');
    connection.checked = true;
    if (!res.ok) {
      // The host answered, but there is no service here. Asking for a secret
      // would be pointless: there is nothing for it to authenticate against.
      connection.live = false;
      connection.service = 'absent';
      connection.reason = 'No lead service at this address';
      return false;
    }
    connection.service = 'present';
    if (!getSecret()) { connection.live = false; connection.reason = 'No API secret'; return false; }
    // Confirm the secret actually works and the portal is reachable.
    await call('/api/crm/reference');
    return true;
  } catch {
    connection.checked = true;
    if (connection.service !== 'present') {
      connection.service = connection.service === 'absent' ? 'absent' : 'unreachable';
    }
    return false;
  }
}

/* ── Shaping ──────────────────────────────────────────────────────────────
   The service speaks Bitrix's vocabulary; the UI has its own. One place to
   translate, so components never deal with STATUS_SEMANTIC_ID or UF_ fields.
   ---------------------------------------------------------------------- */

/**
 * Bitrix status -> a semantic key the UI colours by. The human-readable label
 * always comes from the portal itself (`statusLabel`), so a status renamed in
 * Bitrix shows through without a code change.
 */
function statusKey(l) {
  if (l.statusId === 'JUNK' || l.statusSemantic === 'F') return 'failed';
  if (l.statusId === 'CONVERTED' || l.statusSemantic === 'S') return 'created';
  if (l.statusId === 'NEW') return 'new';
  return 'processing';
}

/** Confidence keys differ (`phones`/`emails` are collections). */
function shapeConfidence(conf) {
  if (!conf) return { overall: null, fields: {} };
  const fields = {
    name: conf.name, company: conf.company, position: conf.position,
    country: conf.country, phone: conf.phones, email: conf.emails,
    productInterest: conf.productInterest, priority: conf.priority,
  };
  for (const k of Object.keys(fields)) if (typeof fields[k] !== 'number') delete fields[k];
  // A 0 means the model did not extract that field, so it must not drag the
  // headline average down.
  const scored = Object.values(fields).filter((v) => v > 0);
  return {
    overall: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
    fields,
  };
}

function shapeProvenance(prov) {
  if (!prov) return {};
  const out = {};
  for (const [field, p] of Object.entries(prov)) {
    if (!p || !p.messageId) continue;   // 'inferred' claims no message
    out[field] = {
      messageId: p.messageId,
      quote: p.quote || null,
      ...(p.method === 'value' ? { note: 'Located by matching the extracted value' } : {}),
    };
  }
  return out;
}

function shapeLead(l) {
  return {
    id: String(l.bitrixLeadId),
    bitrixLeadId: l.bitrixLeadId,
    status: statusKey(l),
    statusId: l.statusId,
    statusLabel: l.statusLabel,
    createdAt: l.createdAt,
    person: { name: l.name, position: l.position },
    // Other leads carrying the same name — surfaced in the list so a possible
    // duplicate is visible without opening the Duplicates screen.
    sameName: { count: l.sameNameCount || 0, ids: l.sameNameIds || [], kind: l.sameNameKind || 'same' },
    company: l.company,
    country: l.region,
    region: l.region,
    exhibition: l.exhibition,
    owner: l.owner ? { name: l.owner, id: l.ownerId } : null,
    leadType: l.leadType,
    productInterest: l.productInterest,
    priority: l.priority,
    phones: (l.phones || []).map((value) => ({ value, type: 'WORK' })),
    emails: (l.emails || []).map((value) => ({ value, type: 'WORK' })),
    teamsAuthor: l.teamsAuthor,
    url: l.url,
    /** False for a lead typed straight into Bitrix — it has no AI metadata. */
    fromPipeline: l.fromPipeline,
    localId: l.localId,
    confidence: shapeConfidence(l.confidence),
    warnings: [],
    needsAttachmentRetry: false,
    sourceMessages: [],
    provenance: {},
  };
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Try the live service; fall back to fixtures if it cannot be reached.
 *
 * The caller gets usable data either way — a dropped connection shows a working
 * interface rather than an error wall — but `dataSource` flips to 'sample' so
 * the UI can say plainly that this is not real data.
 */
async function callOrSample(path, fallback) {
  try {
    const data = await call(path);
    dataSource.mode = 'live';
    dataSource.reason = '';
    return data;
  } catch (err) {
    dataSource.mode = 'sample';
    dataSource.reason = err?.message || 'The live service could not be reached.';
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

export async function getLeads() {
  return (await callOrSample('/api/crm/leads', sample.LEADS)).map(shapeLead);
}

export async function getLead(bitrixId) {
  const l = await callOrSample(
    `/api/crm/leads/${encodeURIComponent(bitrixId)}`,
    () => ({ ...sample.LEAD_DETAIL, bitrixLeadId: Number(bitrixId) || sample.LEAD_DETAIL.bitrixLeadId }),
  );
  const msgs = (l.sourceMessages || []).map((m, i) => ({
    id: m.messageId || `m-${i}`,
    ts: m.timestamp,
    type: m.type,
    text: m.text,
    transcript: m.transcript,
    ocrText: m.ocrText,
    author: m.author,
    attachmentPending: !!m.attachmentPending,
  }));

  return {
    ...shapeLead(l),
    confidence: shapeConfidence(l.confidence),
    provenance: shapeProvenance(l.provenance),
    warnings: l.warnings || [],
    verbatim: l.verbatim || '',
    aiSummary: l.aiSummary || '',
    sourceMessages: msgs,
    needsAttachmentRetry: msgs.some((m) => m.attachmentPending),
    journal: buildJournal(l, msgs),
    crm: {
      state: statusKey(l) === 'failed' ? 'failed' : 'created',
      bitrixLeadId: l.bitrixLeadId,
      url: l.url,
      // Mirror to Bitrix24 (only populated when the service writes to both).
      mirror: l.crmLeadId != null || l.crmError
        ? { leadId: l.crmLeadId ?? null, url: l.crmUrl ?? null, syncedAt: l.crmSyncedAt ?? null, error: l.crmError ?? null }
        : null,
    },
  };
}

/**
 * A processing journal assembled from what is actually recorded — the source
 * messages and the CRM outcome. Per-stage timings are not stored, so none are
 * shown rather than being fabricated.
 */
function buildJournal(l, msgs) {
  const entries = msgs.map((m) => ({
    ts: m.ts,
    label: `${m.type === 'voice' ? 'Voice' : m.type === 'image' ? 'Image' : 'Text'} message received`,
    detail: m.attachmentPending ? 'Attachment not retrievable — flagged for retry' : null,
    tone: m.attachmentPending ? 'warn' : 'info',
  }));
  if (l.bitrixLeadId) {
    entries.push({
      ts: l.createdAt,
      label: `Lead created #${l.bitrixLeadId}`,
      detail: l.owner ? `Owner: ${l.owner}` : null,
      tone: 'ok',
    });
  }
  return entries;
}

export async function getAnalytics()  { return callOrSample('/api/crm/analytics', sample.ANALYTICS); }
export async function getDuplicates() { return callOrSample('/api/crm/duplicates', sample.DUPLICATES); }
export async function getAttention()  { return callOrSample('/api/crm/attention', sample.ATTENTION); }
export async function getReference()  { return callOrSample('/api/crm/reference', sample.REFERENCE); }
export async function getSystem()     { return callOrSample('/api/system', sample.SYSTEM); }

/** Recent service activity, newest first. */
/**
 * Move a lead along the funnel. This is the console's only write to a lead,
 * so it is explicit rather than hidden behind an inline edit.
 */
export async function setLeadStatus(id, statusId) {
  const secret = getSecret();
  if (!secret) throw new ApiError('This console needs the API secret first.', { kind: 'auth' });
  const res = await fetch(`/api/crm/leads/${id}/status`, {
    method: 'POST',
    headers: { 'x-api-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ statusId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || 'The status could not be saved.', { kind: 'write' });
  }
  return res.json();
}

/** The funnel, in order. Labels match what the console shows elsewhere. */
export const LEAD_STATUSES = [
  { id: 'NEW', label: 'Unprocessed' },
  { id: 'IN_PROCESS', label: 'In progress' },
  { id: 'CONVERTED', label: 'Completed' },
  { id: 'JUNK', label: 'Rejected' },
];

export async function getLogs(limit = 200) {
  return callOrSample(`/api/logs?limit=${limit}`, sample.LOGS);
}

/** Dashboard figures, derived from the portal's own leads. */
export async function getDashboard() {
  const [leads, attention] = await Promise.all([getLeads(), getAttention()]);
  const created = leads.filter((l) => l.status === 'created').length;
  const failed = leads.filter((l) => l.status === 'failed').length;
  const fromPipeline = leads.filter((l) => l.fromPipeline).length;

  return {
    kpis: {
      leads: leads.length,
      fromPipeline,
      review: attention.length,
      errors: failed,
      created,
      manual: leads.length - fromPipeline,
    },
    pipeline: [
      { key: 'messages', name: 'Messages', count: null, note: 'ingested from Teams' },
      { key: 'grouping', name: 'Grouping', count: null, note: 'per author' },
      { key: 'extraction', name: 'Extraction', count: null, note: 'fields + confidence' },
      { key: 'validation', name: 'Validation', count: null, note: 'confidence gate' },
      { key: 'resolution', name: 'Review', count: attention.length, note: 'needs attention', active: attention.length > 0 },
      { key: 'crm', name: 'Lead created', count: leads.length, note: 'leads', terminal: true },
    ],
    activity: leads.slice(0, 8).map((l) => ({
      ts: l.createdAt,
      tone: l.status === 'failed' ? 'danger' : l.status === 'created' ? 'ok' : 'info',
      title: [l.person.name, l.company].filter(Boolean).join(' / ') || l.statusLabel,
      note: l.fromPipeline ? 'Created from Teams' : 'Added directly',
      state: `#${l.bitrixLeadId}`,
    })),
    leads,
  };
}

/** Re-drive a failed lead's session through the pipeline. */
export async function resendLead(localId) {
  const secret = getSecret();
  const res = await fetch(`/api/leads/${encodeURIComponent(localId)}/resend`, {
    method: 'POST',
    headers: { 'x-api-secret': secret },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: false,
      message: body.error === 'lead is not in failed state'
        ? 'This lead is not in a failed state.'
        : 'The resend could not be started.',
    };
  }
  return { ok: true, message: 'Lead re-submitted for processing.' };
}

/** Field labels used by the lead detail + evidence panel. */
export const FIELD_LABELS = {
  name: 'Name',
  company: 'Company',
  position: 'Position',
  phone: 'Phone',
  email: 'Email',
  country: 'Region',
  productInterest: 'Product interest',
  priority: 'Priority',
};
