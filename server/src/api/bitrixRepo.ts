/**
 * Read model for the operations console.
 *
 * Bitrix24 is the system of record for a lead, but it does not store the AI
 * metadata this pipeline produces (per-field confidence, provenance, the source
 * Teams messages). So a screen's data is a MERGE:
 *
 *   Bitrix   -> the lead itself: fields, status, owner, list values, CRM id
 *   local DB -> confidence, provenance, source messages, verbatim, AI summary
 *
 * The two are joined on the Bitrix lead id. Nothing here is invented: a lead the
 * pipeline did not create simply has no AI metadata, and the UI shows it as
 * such.
 *
 * Reference data (user names, status and userfield labels) is fetched once and
 * cached, because the portal is rate-limited to 2 req/s and the console would
 * otherwise re-resolve the same labels on every request.
 */

import type { Db } from '../db/index.js';
import type { BitrixTransport } from '../bitrix/transport.js';
import { portalOrigin } from '../bitrix/transport.js';
import { RateLimiter } from '../bitrix/rateLimiter.js';

export interface RepoOptions {
  db: Db;
  transport: BitrixTransport;
  webhookUrl: string;
  /** Reference-data cache lifetime. */
  refTtlMs?: number;
  /** Lead-list cache lifetime — keeps the console snappy without hammering. */
  leadTtlMs?: number;
}

interface Cached<T> { value: T; at: number; }

const LIST_FIELDS = [
  'UF_CRM_LEAD_TYPE',
  'UF_CRM_REGION',
  'UF_CRM_PRODUCT_INTEREST',
  'UF_CRM_PRIORITY',
] as const;

export interface RefData {
  /** field code -> (option id -> label) */
  lists: Record<string, Record<string, string>>;
  /** bitrix user id -> display name */
  users: Record<string, string>;
  /** STATUS_ID -> label */
  statuses: Record<string, string>;
}

export class BitrixRepo {
  private readonly limiter: RateLimiter;
  private readonly origin: string;
  private refCache: Cached<RefData> | null = null;
  private leadCache: Cached<BitrixLeadRow[]> | null = null;

  constructor(private readonly opts: RepoOptions) {
    this.limiter = new RateLimiter({ ratePerSec: 2 });
    this.origin = portalOrigin(opts.webhookUrl);
  }

  private get refTtl() { return this.opts.refTtlMs ?? 10 * 60_000; }
  private get leadTtl() { return this.opts.leadTtlMs ?? 15_000; }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
    const { status, body } = await this.limiter.run(() => this.opts.transport(method, params));
    if (status < 200 || status >= 300 || body.error) return null;
    return body.result as T;
  }

  leadUrl(id: number): string {
    return `${this.origin}/crm/lead/details/${id}/`;
  }

  /** Reference labels, cached. Returns empty maps if the portal is unreachable. */
  async reference(): Promise<RefData> {
    if (this.refCache && Date.now() - this.refCache.at < this.refTtl) return this.refCache.value;

    const data: RefData = { lists: {}, users: {}, statuses: {} };

    const fields = await this.call<Array<Record<string, unknown>>>('crm.lead.userfield.list', {});
    for (const f of fields ?? []) {
      const code = String(f.FIELD_NAME ?? '');
      if (!(LIST_FIELDS as readonly string[]).includes(code)) continue;
      const options = (f.LIST as Array<{ ID: string | number; VALUE: string }> | undefined) ?? [];
      data.lists[code] = Object.fromEntries(options.map((o) => [String(o.ID), o.VALUE]));
    }

    const users = await this.call<Array<Record<string, unknown>>>('user.get', {});
    for (const u of users ?? []) {
      const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim();
      data.users[String(u.ID)] = name || `User #${u.ID}`;
    }

    const statuses = await this.call<Array<Record<string, unknown>>>('crm.status.list', {
      filter: { ENTITY_ID: 'STATUS' },
    });
    for (const s of statuses ?? []) data.statuses[String(s.STATUS_ID)] = String(s.NAME ?? s.STATUS_ID);

    this.refCache = { value: data, at: Date.now() };
    return data;
  }

  /** Raw lead rows from the portal, cached briefly. */
  private async rawLeads(): Promise<BitrixLeadRow[]> {
    if (this.leadCache && Date.now() - this.leadCache.at < this.leadTtl) return this.leadCache.value;
    const rows = await this.call<BitrixLeadRow[]>('crm.lead.list', {
      select: ['*', 'UF_*', 'PHONE', 'EMAIL'],
      order: { ID: 'DESC' },
    });
    const value = rows ?? [];
    this.leadCache = { value, at: Date.now() };
    return value;
  }

  /** Every lead in the portal, shaped for the console. */
  async leads(): Promise<ConsoleLead[]> {
    const [rows, ref] = await Promise.all([this.rawLeads(), this.reference()]);
    const local = this.localByBitrixId();
    return rows.map((r) => this.toConsoleLead(r, ref, local));
  }

  /** One lead, with its AI metadata and source messages when we have them. */
  async lead(bitrixId: number): Promise<ConsoleLeadDetail | null> {
    const [rows, ref] = await Promise.all([this.rawLeads(), this.reference()]);
    const row = rows.find((r) => Number(r.ID) === bitrixId);
    if (!row) return null;

    const local = this.localByBitrixId();
    const base = this.toConsoleLead(row, ref, local);
    const localRow = local.get(bitrixId);

    // The AI summary is stored as a timeline comment on the lead.
    const comments = await this.call<Array<Record<string, unknown>>>('crm.timeline.comment.list', {
      filter: { ENTITY_ID: bitrixId, ENTITY_TYPE: 'lead' },
    });
    const timelineSummary = (comments ?? []).map((c) => String(c.COMMENT ?? '')).filter(Boolean)[0] ?? null;

    const fields = localRow?.fields_json ? safeJson(localRow.fields_json) : null;
    const gated = (fields as { gated?: Record<string, unknown> } | null)?.gated ?? null;
    const session = localRow ? this.opts.db.getSession(localRow.session_id) : null;
    const bundle = session ? safeJson(session.raw_payload_json) as { items?: SourceItem[]; author?: { displayName?: string } } | null : null;

    return {
      ...base,
      verbatim: localRow?.transcript_verbatim ?? str(row.COMMENTS) ?? '',
      aiSummary: localRow?.ai_summary_ru ?? timelineSummary ?? '',
      warnings: localRow?.warnings_json ? (safeJson(localRow.warnings_json) as string[]) ?? [] : [],
      confidence: (gated?.confidence as Record<string, number> | undefined) ?? base.confidence,
      provenance: (gated?.provenance as Record<string, unknown> | undefined) ?? null,
      sourceMessages: (bundle?.items ?? []).map((i) => ({
        messageId: i.messageId,
        timestamp: i.timestamp,
        type: i.type,
        text: i.text ?? null,
        transcript: i.transcript ?? null,
        ocrText: i.ocrText ?? null,
        author: bundle?.author?.displayName ?? null,
        attachmentPending: !!i.attachmentPending,
      })),
      localId: localRow?.id ?? null,
    };
  }

  /**
   * Duplicate candidates: leads that share a normalised phone or email.
   * Computed from the portal's own data rather than a stored decision, so it
   * reflects the CRM as it is right now.
   */
  async duplicates(): Promise<DuplicatePair[]> {
    const leads = await this.leads();
    const byKey = new Map<string, ConsoleLead[]>();
    for (const l of leads) {
      for (const key of commKeys(l)) {
        const arr = byKey.get(key) ?? [];
        arr.push(l);
        byKey.set(key, arr);
      }
    }
    const seen = new Set<string>();
    const pairs: DuplicatePair[] = [];
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const [a, b] = group;
      const id = `${a!.bitrixLeadId}-${b!.bitrixLeadId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      pairs.push(buildPair(a!, b!));
    }
    return pairs;
  }

  /** Aggregates for the analytics screen, computed from the portal's leads. */
  async analytics(): Promise<Analytics> {
    const leads = await this.leads();
    const count = (pred: (l: ConsoleLead) => boolean) => leads.filter(pred).length;
    const tally = (get: (l: ConsoleLead) => string | null) => {
      const m = new Map<string, number>();
      for (const l of leads) {
        const k = get(l);
        if (!k) continue;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m.entries()].map(([label, value]) => ({ label, value })).sort((x, y) => y.value - x.value);
    };

    // Volume per day, oldest first.
    const byDay = new Map<string, number>();
    for (const l of leads) {
      const day = (l.createdAt || '').slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    return {
      totals: {
        leads: leads.length,
        customers: count((l) => l.leadType === 'Customer'),
        partners: count((l) => l.leadType === 'Partner'),
        highPriority: count((l) => l.priority === 'High'),
      },
      byInterest: tally((l) => l.productInterest),
      byPriority: tally((l) => l.priority),
      byManager: tally((l) => l.owner),
      byStatus: tally((l) => l.statusLabel),
      overTime: [...byDay.entries()].sort().map(([label, value]) => ({ label, value })),
    };
  }

  /** Leads that need a human decision, from our own processing record. */
  async needsAttention(): Promise<AttentionItem[]> {
    const rows = this.opts.db.listLeads();
    return rows
      .filter((r) => r.status === 'failed' || r.needs_attachment_retry === 1 || hasWarning(r.warnings_json))
      .map((r) => ({
        localId: r.id,
        bitrixLeadId: r.bitrix_lead_id,
        title: r.title,
        status: r.status,
        needsAttachmentRetry: r.needs_attachment_retry === 1,
        warnings: (safeJson(r.warnings_json ?? '[]') as string[]) ?? [],
        createdAt: r.created_at,
      }));
  }

  // ── internals ───────────────────────────────────────────────

  /** Our locally-processed leads, indexed by the Bitrix id they were written to. */
  private localByBitrixId() {
    const map = new Map<number, ReturnType<Db['listLeads']>[number]>();
    for (const r of this.opts.db.listLeads()) {
      if (r.bitrix_lead_id != null) map.set(r.bitrix_lead_id, r);
    }
    return map;
  }

  private toConsoleLead(
    r: BitrixLeadRow,
    ref: RefData,
    local: Map<number, ReturnType<Db['listLeads']>[number]>,
  ): ConsoleLead {
    const id = Number(r.ID);
    const label = (field: string) => {
      const v = r[field];
      if (v == null || v === '' || v === false) return null;
      return ref.lists[field]?.[String(v)] ?? null;
    };
    const name = [r.NAME, r.SECOND_NAME, r.LAST_NAME].filter(Boolean).join(' ').trim();
    const localRow = local.get(id);

    return {
      bitrixLeadId: id,
      title: str(r.TITLE) ?? (name || null) ?? `Lead #${id}`,
      name: name || null,
      company: str(r.COMPANY_TITLE),
      position: str(r.POST),
      owner: ref.users[String(r.ASSIGNED_BY_ID)] ?? null,
      ownerId: Number(r.ASSIGNED_BY_ID) || null,
      statusId: str(r.STATUS_ID),
      statusLabel: ref.statuses[String(r.STATUS_ID)] ?? str(r.STATUS_ID),
      statusSemantic: str(r.STATUS_SEMANTIC_ID),
      leadType: label('UF_CRM_LEAD_TYPE'),
      region: label('UF_CRM_REGION'),
      productInterest: label('UF_CRM_PRODUCT_INTEREST'),
      priority: label('UF_CRM_PRIORITY'),
      phones: multi(r.PHONE),
      emails: multi(r.EMAIL),
      createdAt: str(r.DATE_CREATE),
      teamsAuthor: str(r.UF_CRM_TEAMS_AUTHOR),
      url: this.leadUrl(id),
      // Only true when this pipeline created the lead — a lead entered by hand
      // in Bitrix legitimately has no AI metadata.
      fromPipeline: !!localRow,
      localId: localRow?.id ?? null,
      // Confidence travels with the summary too, so the list can rank by it.
      confidence: localRow ? confidenceOf(localRow.fields_json) : null,
    };
  }
}

/* ── shapes ─────────────────────────────────────────────────── */

type BitrixLeadRow = Record<string, unknown> & { ID: string | number };
interface SourceItem {
  messageId: string; timestamp: string; type: string;
  text?: string; transcript?: string; ocrText?: string | null; attachmentPending?: boolean;
}

export interface ConsoleLead {
  bitrixLeadId: number;
  title: string;
  name: string | null;
  company: string | null;
  position: string | null;
  owner: string | null;
  ownerId: number | null;
  statusId: string | null;
  statusLabel: string | null;
  statusSemantic: string | null;
  leadType: string | null;
  region: string | null;
  productInterest: string | null;
  priority: string | null;
  phones: string[];
  emails: string[];
  createdAt: string | null;
  teamsAuthor: string | null;
  url: string;
  fromPipeline: boolean;
  localId: string | null;
  confidence: Record<string, number> | null;
}

export interface ConsoleLeadDetail extends ConsoleLead {
  verbatim: string;
  aiSummary: string;
  warnings: string[];
  confidence: Record<string, number> | null;
  provenance: Record<string, unknown> | null;
  sourceMessages: Array<{
    messageId: string; timestamp: string; type: string;
    text: string | null; transcript: string | null; ocrText: string | null;
    author: string | null; attachmentPending: boolean;
  }>;
}

export interface DuplicatePair {
  id: string;
  similarity: number;
  left: ConsoleLead;
  right: ConsoleLead;
  signals: Array<{ label: string; match: boolean }>;
  sameOwner: boolean;
}

export interface Analytics {
  totals: { leads: number; customers: number; partners: number; highPriority: number };
  byInterest: Array<{ label: string; value: number }>;
  byPriority: Array<{ label: string; value: number }>;
  byManager: Array<{ label: string; value: number }>;
  byStatus: Array<{ label: string; value: number }>;
  overTime: Array<{ label: string; value: number }>;
}

export interface AttentionItem {
  localId: string;
  bitrixLeadId: number | null;
  title: string | null;
  status: string;
  needsAttachmentRetry: boolean;
  warnings: string[];
  createdAt: string;
}

/* ── helpers ────────────────────────────────────────────────── */

/** Pull the stored per-field confidence out of a local lead row. */
function confidenceOf(fieldsJson: string | null): Record<string, number> | null {
  if (!fieldsJson) return null;
  const parsed = safeJson(fieldsJson) as { gated?: { confidence?: Record<string, number> } } | null;
  return parsed?.gated?.confidence ?? null;
}

/** Bitrix returns '' / false for unset fields; normalise those to null. */
function str(v: unknown): string | null {
  if (v == null || v === '' || v === false) return null;
  return String(v);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function hasWarning(json: string | null): boolean {
  if (!json) return false;
  const v = safeJson(json);
  return Array.isArray(v) && v.length > 0;
}

/** Bitrix multi-fields arrive as [{VALUE, VALUE_TYPE}]. */
function multi(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String((x as { VALUE?: unknown }).VALUE ?? '')).filter(Boolean);
}

const digits = (s: string) => s.replace(/\D/g, '');

/** Comparable comm keys used to spot duplicates. */
function commKeys(l: ConsoleLead): string[] {
  return [
    ...l.emails.map((e) => 'e:' + e.toLowerCase().trim()),
    ...l.phones.map((p) => 'p:' + digits(p)).filter((k) => k.length > 6),
  ];
}

function buildPair(a: ConsoleLead, b: ConsoleLead): DuplicatePair {
  const sameEmail = a.emails.some((e) => b.emails.some((x) => x.toLowerCase() === e.toLowerCase()));
  const samePhone = a.phones.some((p) => b.phones.some((x) => digits(x) === digits(p)));
  const sameCompany = !!a.company && a.company === b.company;
  const sameName = !!a.name && a.name.toLowerCase() === (b.name ?? '').toLowerCase();
  const samePosition = !!a.position && a.position === b.position;
  const sameOwner = a.ownerId === b.ownerId;

  const signals = [
    { label: 'Same email', match: sameEmail },
    { label: 'Same normalised phone', match: samePhone },
    { label: 'Same company', match: sameCompany },
    { label: 'Same name', match: sameName },
    { label: 'Same position', match: samePosition },
    { label: 'Same owner', match: sameOwner },
  ];
  const similarity = signals.filter((s) => s.match).length / signals.length;
  return { id: `${a.bitrixLeadId}-${b.bitrixLeadId}`, similarity, left: a, right: b, signals, sameOwner };
}
