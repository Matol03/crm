/**
 * Read model over the platform's own lead store (LEAD_SINK=platform).
 *
 * Emits exactly the shapes `BitrixRepo` emits (ConsoleLead / Analytics / ...),
 * so the console renders identically whichever sink is active. The difference
 * is the source: leads come from `platform_leads`, and confidence/provenance/
 * source-messages are joined from the pipeline's own `leads` + `sessions` rows
 * — no external call, so these screens work with no CRM attached at all.
 */

import type { Db } from '../db/index.js';
import type {
  ConsoleLead,
  ConsoleLeadDetail,
  DuplicatePair,
  Analytics,
  AttentionItem,
  RefData,
} from './bitrixRepo.js';
import { SEED_USERFIELD_VALUES } from '../bitrix/mock.js';

/** Status catalog for the platform's own pipeline stages. */
const STATUSES: Record<string, { label: string; semantic: string }> = {
  NEW: { label: 'Unprocessed', semantic: 'P' },
  IN_PROCESS: { label: 'In progress', semantic: 'P' },
  CONVERTED: { label: 'Converted', semantic: 'S' },
  JUNK: { label: 'Rejected', semantic: 'F' },
};

interface PlatformRow {
  id: number; local_id: string; session_id: string; title: string | null;
  name: string | null; company: string | null; position: string | null; country: string | null;
  owner_id: number | null; status_id: string;
  lead_type: string | null; region: string | null; exhibition: string | null;
  product_interest: string | null; priority: string | null;
  phones_json: string; emails_json: string;
  verbatim: string | null; ai_summary: string | null; teams_author: string | null;
  bitrix_lead_id: number | null; bitrix_synced_at: string | null; bitrix_error: string | null;
  created_at: string; updated_at: string;
}

/** Portal base URL, derived from the webhook without leaking its secret path. */
function portalBase(webhookUrl?: string): string | null {
  if (!webhookUrl) return null;
  try { return new URL(webhookUrl).origin; } catch { return null; }
}

export interface PlatformRepoOptions {
  db: Db;
  /** Used only to build outbound card links for mirrored leads. */
  bitrixWebhookUrl?: string;
}

export class PlatformRepo {
  private readonly db: Db;
  private readonly portalOrigin: string | null;

  constructor(opts: PlatformRepoOptions) {
    this.db = opts.db;
    this.portalOrigin = portalBase(opts.bitrixWebhookUrl);
  }

  /** Owner id -> display name, from the Teams->owner mapping table. */
  private owners(): Map<number, string> {
    const rows = this.db.handle
      .prepare('SELECT bitrix_user_id, display_name FROM employee_map')
      .all() as Array<{ bitrix_user_id: number; display_name: string | null }>;
    const m = new Map<number, string>();
    for (const r of rows) if (r.display_name) m.set(r.bitrix_user_id, r.display_name);
    return m;
  }

  async leads(): Promise<ConsoleLead[]> {
    const rows = this.db.handle
      .prepare('SELECT * FROM platform_leads ORDER BY datetime(created_at) DESC, id DESC')
      .all() as unknown as PlatformRow[];
    const owners = this.owners();
    return rows.map((r) => this.toConsoleLead(r, owners));
  }

  async lead(id: number): Promise<ConsoleLeadDetail | null> {
    const row = this.db.handle
      .prepare('SELECT * FROM platform_leads WHERE id = ?')
      .get(id) as unknown as PlatformRow | undefined;
    if (!row) return null;

    const base = this.toConsoleLead(row, this.owners());
    const local = this.db.getLead(row.local_id);
    const fields = safeJson(local?.fields_json ?? null) as
      | { gated?: { provenance?: Record<string, unknown> } }
      | null;

    return {
      ...base,
      verbatim: row.verbatim ?? '',
      aiSummary: row.ai_summary ?? '',
      warnings: (safeJson(local?.warnings_json ?? null) as string[] | null) ?? [],
      confidence: base.confidence,
      provenance: fields?.gated?.provenance ?? null,
      sourceMessages: this.sourceMessages(row.session_id, row.local_id),
    };
  }

  /**
   * The session's messages that fed this lead. The pipeline records which
   * message ids a lead came from, so unrelated messages in the same session
   * are not shown as its sources.
   */
  private sourceMessages(sessionId: string, localId: string): ConsoleLeadDetail['sourceMessages'] {
    const session = this.db.getSession(sessionId);
    if (!session) return [];
    const bundle = safeJson(session.raw_payload_json) as
      | { author?: { displayName?: string; email?: string }; items?: Array<Record<string, unknown>> }
      | null;
    if (!bundle?.items) return [];

    const local = this.db.getLead(localId);
    const wanted = new Set(
      ((safeJson(local?.fields_json ?? null) as { messageIds?: string[] } | null)?.messageIds) ?? [],
    );
    const author = bundle.author?.displayName ?? bundle.author?.email ?? null;

    return bundle.items
      .filter((i) => wanted.size === 0 || wanted.has(String(i['messageId'])))
      .map((i) => ({
        messageId: String(i['messageId'] ?? ''),
        timestamp: String(i['timestamp'] ?? ''),
        type: String(i['type'] ?? 'text'),
        text: (i['text'] as string) ?? null,
        transcript: (i['transcript'] as string) ?? null,
        ocrText: (i['ocrText'] as string) ?? null,
        author,
        attachmentPending: i['attachmentPending'] === true,
      }));
  }

  /**
   * Leads sharing a phone or email that were NOT merged — i.e. reported by
   * different managers. Same-author duplicates never reach here; the store
   * merges those on write.
   */
  async duplicates(): Promise<DuplicatePair[]> {
    const all = await this.leads();
    const pairs: DuplicatePair[] = [];

    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!, b = all[j]!;
        const phone = overlap(a.phones.map(onlyDigits), b.phones.map(onlyDigits));
        const email = overlap(a.emails.map(lower), b.emails.map(lower));
        const name = a.name && b.name && lower(a.name) === lower(b.name);
        const company = a.company && b.company && lower(a.company) === lower(b.company);
        if (!phone && !email && !(name && company)) continue;

        const signals = [
          { label: 'Phone', match: phone },
          { label: 'Email', match: email },
          { label: 'Name', match: !!name },
          { label: 'Company', match: !!company },
        ];
        const hits = signals.filter((s) => s.match).length;
        pairs.push({
          id: `${a.bitrixLeadId}-${b.bitrixLeadId}`,
          similarity: Math.min(0.99, hits / signals.length),
          left: a,
          right: b,
          signals,
          sameOwner: a.ownerId != null && a.ownerId === b.ownerId,
        });
      }
    }
    return pairs.sort((x, y) => y.similarity - x.similarity);
  }

  async analytics(): Promise<Analytics> {
    const all = await this.leads();
    const count = (pick: (l: ConsoleLead) => string | null) => {
      const m = new Map<string, number>();
      for (const l of all) {
        const k = pick(l);
        if (!k) continue;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return Array.from(m, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    };

    const byDay = new Map<string, number>();
    for (const l of all) {
      const day = (l.createdAt ?? '').slice(0, 10);
      if (day) byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    return {
      totals: {
        leads: all.length,
        customers: all.filter((l) => l.leadType === 'Customer').length,
        partners: all.filter((l) => l.leadType === 'Partner').length,
        highPriority: all.filter((l) => l.priority === 'High').length,
      },
      byInterest: count((l) => l.productInterest),
      byPriority: count((l) => l.priority),
      byManager: count((l) => l.owner),
      byStatus: count((l) => l.statusLabel),
      overTime: Array.from(byDay, ([label, value]) => ({ label, value })).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    };
  }

  /** Pipeline rows that failed, carry warnings, or await an attachment. */
  async needsAttention(): Promise<AttentionItem[]> {
    const rows = this.db.listLeads();
    return rows
      .filter((r) => {
        const warns = (safeJson(r.warnings_json) as string[] | null) ?? [];
        return r.status === 'failed' || r.needs_attachment_retry === 1 || warns.length > 0;
      })
      .map((r) => ({
        localId: r.id,
        bitrixLeadId: r.bitrix_lead_id,
        title: r.title,
        status: r.status,
        needsAttachmentRetry: r.needs_attachment_retry === 1,
        warnings: (safeJson(r.warnings_json) as string[] | null) ?? [],
        createdAt: r.created_at,
      }));
  }

  async reference(): Promise<RefData> {
    const lists: Record<string, Record<string, string>> = {};
    for (const [code, values] of Object.entries(SEED_USERFIELD_VALUES)) {
      lists[code] = Object.fromEntries(values.map((v) => [String(v.id), v.label]));
    }
    const users: Record<string, string> = {};
    for (const [id, name] of this.owners()) users[String(id)] = name;
    const statuses: Record<string, string> = {};
    for (const [id, s] of Object.entries(STATUSES)) statuses[id] = s.label;

    return { lists, users, statuses };
  }

  // ── mapping ──────────────────────────────────────────────────

  private toConsoleLead(r: PlatformRow, owners: Map<number, string>): ConsoleLead {
    const local = this.db.getLead(r.local_id);
    const parsed = safeJson(local?.fields_json ?? null) as
      | {
          gated?: {
            confidence?: Record<string, number>;
            productInterestRaw?: string | null;
            priorityRaw?: string | null;
          };
        }
      | null;
    const gated = parsed?.gated;
    const status = STATUSES[r.status_id] ?? { label: r.status_id, semantic: 'P' };

    // The stored column holds a value matched to Bitrix's dropdown list. When
    // nothing matched it is null — but the platform has no fixed option list,
    // so show what was actually extracted rather than dropping it. This is the
    // real captured text, never an invented one.
    const productInterest = r.product_interest ?? gated?.productInterestRaw ?? null;
    const priority = r.priority ?? gated?.priorityRaw ?? null;

    return {
      bitrixLeadId: r.id,
      title: r.title ?? '',
      name: r.name,
      company: r.company,
      position: r.position,
      owner: r.owner_id != null ? owners.get(r.owner_id) ?? `User #${r.owner_id}` : null,
      ownerId: r.owner_id,
      statusId: r.status_id,
      statusLabel: status.label,
      statusSemantic: status.semantic,
      leadType: r.lead_type,
      region: r.region,
      exhibition: r.exhibition,
      productInterest,
      priority,
      phones: parseArr(r.phones_json),
      emails: parseArr(r.emails_json),
      createdAt: r.created_at,
      teamsAuthor: r.teams_author,
      url: `#/leads/${r.id}`,
      // Every platform lead came through the pipeline by construction.
      fromPipeline: true,
      localId: r.local_id,
      confidence: gated?.confidence ?? null,
      // Mirror state (LEAD_SINK=both). Null everywhere else, so the console
      // simply shows nothing rather than implying a portal that isn't in use.
      crmLeadId: r.bitrix_lead_id,
      crmUrl:
        r.bitrix_lead_id != null && this.portalOrigin
          ? `${this.portalOrigin}/crm/lead/details/${r.bitrix_lead_id}/`
          : null,
      crmSyncedAt: r.bitrix_synced_at,
      crmError: r.bitrix_error,
    } as ConsoleLead & {
      crmLeadId: number | null; crmUrl: string | null;
      crmSyncedAt: string | null; crmError: string | null;
    };
  }
}

/* ── helpers ─────────────────────────────────────────────────── */

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function parseArr(json: string): string[] {
  const v = safeJson(json);
  return Array.isArray(v) ? v.map(String) : [];
}

const lower = (s: string) => s.trim().toLowerCase();
const onlyDigits = (s: string) => s.replace(/\D/g, '');

function overlap(a: string[], b: string[]): boolean {
  const set = new Set(a.filter(Boolean));
  return b.some((x) => x && set.has(x));
}
