/**
 * Platform lead sink — the console's own CRM (LEAD_SINK=platform).
 *
 * Implements the same `BitrixClient` contract as the real portal client, so the
 * pipeline is unchanged: it still "writes leads" and still gets ids back, but
 * they land in `platform_leads` and surface on the dashboard instead of going
 * out to Bitrix24. That keeps the CRM path available as a config flip rather
 * than a rewrite.
 *
 * Behaviours deliberately mirrored from the portal client:
 *   - list values come from the same seeded catalog, so mapping/labels match
 *   - duplicate lookup is by phone/email and scoped to the Teams author, not
 *     the resolved owner (S10.4 — two unmapped managers must not merge)
 *   - a same-author duplicate is UPDATED in place rather than added twice
 */

import type {
  BitrixClient,
  BitrixLeadRecord,
  DuplicateMatch,
  LeadWrite,
  LeadWriteResult,
} from '../contracts/bitrix.js';
import type { Db } from '../db/index.js';
import { SEED_USERFIELD_VALUES } from '../bitrix/mock.js';

/** Digits-only, so a match survives different phone formatting. */
const digits = (s: string) => s.replace(/\D/g, '');

export interface PlatformStoreOptions {
  db: Db;
  /** Status assigned to a newly created lead (never re-applied on update). */
  initialStatusId?: string;
}

export class PlatformLeadStore implements BitrixClient {
  private readonly db: Db;
  private readonly initialStatusId: string;

  constructor(opts: PlatformStoreOptions) {
    this.db = opts.db;
    this.initialStatusId = opts.initialStatusId ?? 'NEW';
  }

  /**
   * The platform owns its own list values; no portal round-trip. Same catalog
   * the mock uses, so labels and ids stay consistent across sinks.
   */
  async listUserFieldValues(fieldCode: string): Promise<Array<{ label: string; id: number }>> {
    return SEED_USERFIELD_VALUES[fieldCode] ?? [];
  }

  /** Find an existing lead sharing a phone or email (author-scoped). */
  async findDuplicate(comm: { phones: string[]; emails: string[] }): Promise<DuplicateMatch | null> {
    const wantPhones = comm.phones.map(digits).filter((p) => p.length >= 5);
    const wantEmails = comm.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!wantPhones.length && !wantEmails.length) return null;

    const rows = this.db.handle
      .prepare(
        `SELECT id, owner_id, teams_author, phones_json, emails_json
           FROM platform_leads ORDER BY id DESC`,
      )
      .all() as Array<{
        id: number; owner_id: number | null; teams_author: string | null;
        phones_json: string; emails_json: string;
      }>;

    for (const row of rows) {
      const phones = parseComm(row.phones_json).map(digits);
      const emails = parseComm(row.emails_json).map((e) => e.toLowerCase());
      const hit =
        wantPhones.some((p) => phones.includes(p)) || wantEmails.some((e) => emails.includes(e));
      if (hit) {
        return { bitrixLeadId: row.id, ownerId: row.owner_id ?? 0, teamsAuthor: row.teams_author };
      }
    }
    return null;
  }

  /**
   * Persist each lead. A same-author duplicate updates in place; anything else
   * is inserted. Never throws for one bad lead — the failure is reported per
   * lead so the rest of the batch still lands.
   */
  async writeLeads(leads: LeadWrite[]): Promise<LeadWriteResult[]> {
    const out: LeadWriteResult[] = [];

    for (const lead of leads) {
      try {
        const phones = lead.phones.map((p) => p.value);
        const emails = lead.emails.map((e) => e.value);
        const dup = await this.findDuplicate({ phones, emails });
        // Only merge when the SAME manager reported it (S10.4).
        const sameAuthor =
          dup != null && dup.teamsAuthor != null &&
          dup.teamsAuthor.toLowerCase() === lead.service.teamsAuthor.toLowerCase();

        if (dup && sameAuthor) {
          this.update(dup.bitrixLeadId, lead, phones, emails);
          out.push({ localId: lead.localId, bitrixLeadId: dup.bitrixLeadId, updatedExisting: true, error: null });
        } else {
          const id = this.insert(lead, phones, emails);
          out.push({ localId: lead.localId, bitrixLeadId: id, updatedExisting: false, error: null });
        }
      } catch (e) {
        out.push({
          localId: lead.localId,
          bitrixLeadId: null,
          updatedExisting: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  }

  async getLead(id: number): Promise<BitrixLeadRecord | null> {
    const row = this.db.handle
      .prepare('SELECT * FROM platform_leads WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? { id, fields: row } : null;
  }

  /** In-app route rather than a portal URL — the dashboard is the destination. */
  leadUrl(id: number): string {
    return `#/leads/${id}`;
  }

  /** Remove a lead from the platform's own store. */
  async deleteLead(id: number): Promise<void> {
    this.db.handle.prepare('DELETE FROM platform_lead_sources WHERE platform_lead_id = ?').run(id);
    const info = this.db.handle.prepare('DELETE FROM platform_leads WHERE id = ?').run(id);
    if (Number(info.changes ?? 0) === 0) throw new Error(`lead ${id} not found`);
  }

  /**
   * Fold one lead into another: the surviving lead gains any contact details
   * the duplicate had, and the duplicate is removed. Values already present on
   * the survivor win, so a confirmed record is never overwritten by a thinner
   * duplicate — only gaps are filled.
   */
  async mergeLeads(survivorId: number, duplicateId: number): Promise<void> {
    if (survivorId === duplicateId) throw new Error('cannot merge a lead into itself');
    const get = this.db.handle.prepare('SELECT * FROM platform_leads WHERE id = ?');
    const survivor = get.get(survivorId) as Record<string, unknown> | undefined;
    const dup = get.get(duplicateId) as Record<string, unknown> | undefined;
    if (!survivor || !dup) throw new Error('lead not found');

    const phones = unique([
      ...parseComm(String(survivor['phones_json'] ?? '[]')),
      ...parseComm(String(dup['phones_json'] ?? '[]')),
    ]);
    const emails = unique([
      ...parseComm(String(survivor['emails_json'] ?? '[]')),
      ...parseComm(String(dup['emails_json'] ?? '[]')),
    ]);
    const fill = (key: string): string | null => {
      const v = survivor[key] ?? dup[key];
      return v == null || v === '' ? null : String(v);
    };

    this.db.handle
      .prepare(
        `UPDATE platform_leads SET
           name = ?, company = ?, position = ?, country = ?,
           lead_type = ?, region = ?, product_interest = ?, priority = ?,
           phones_json = ?, emails_json = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        fill('name'), fill('company'), fill('position'), fill('country'),
        fill('lead_type'), fill('region'),
        fill('product_interest'), fill('priority'),
        JSON.stringify(phones), JSON.stringify(emails),
        survivorId,
      );
    // The absorbed lead's sources now belong to the survivor, so its evidence
    // does not vanish with the row.
    this.db.handle
      .prepare('UPDATE OR IGNORE platform_lead_sources SET platform_lead_id = ? WHERE platform_lead_id = ?')
      .run(survivorId, duplicateId);
    await this.deleteLead(duplicateId);
  }

  /** A lead's contact details, for locating its copy in the portal. */
  commsFor(id: number): { phones: string[]; emails: string[] } {
    const row = this.db.handle
      .prepare('SELECT phones_json, emails_json FROM platform_leads WHERE id = ?')
      .get(id) as { phones_json: string; emails_json: string } | undefined;
    return {
      phones: parseComm(row?.phones_json ?? '[]'),
      emails: parseComm(row?.emails_json ?? '[]'),
    };
  }

  /** The mirrored portal id for a lead, when it has one. */
  bitrixIdFor(id: number): number | null {
    const row = this.db.handle
      .prepare('SELECT bitrix_lead_id FROM platform_leads WHERE id = ?')
      .get(id) as { bitrix_lead_id: number | null } | undefined;
    return row?.bitrix_lead_id ?? null;
  }

  async setLeadStatus(id: number, statusId: string): Promise<void> {
    this.db.handle
      .prepare(`UPDATE platform_leads SET status_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(statusId, id);
  }

  /**
   * Resolve a list-value id back to its label. The LIVE portal cache is checked
   * first: in dual-sink mode the ids come from the real portal, which may not
   * match the seeded catalog, and a stale seed lookup would mislabel the lead.
   */
  private label(fields: Record<string, unknown>, key: string): string | null {
    const raw = fields[key];
    if (raw == null || raw === '') return null;
    const code = LIST_KEY_TO_FIELD[key];
    const id = Number(raw);
    if (!code || !Number.isFinite(id)) return String(raw);

    const cached = this.db.getCachedListValues(code).find((v) => v.bitrix_id === id);
    if (cached) return cached.label;
    const seeded = (SEED_USERFIELD_VALUES[code] ?? []).find((v) => v.id === id);
    return seeded ? seeded.label : String(raw);
  }

  // ── internals ────────────────────────────────────────────────

  private insert(lead: LeadWrite, phones: string[], emails: string[]): number {
    const f = lead.listFields as unknown as Record<string, unknown>;
    this.db.handle
      .prepare(
        `INSERT INTO platform_leads
           (local_id, session_id, title, name, company, position, country, owner_id,
            status_id, lead_type, region, product_interest, priority,
            phones_json, emails_json, verbatim, ai_summary, teams_author)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        lead.localId, lead.sessionId, lead.title, lead.name, lead.company, lead.position,
        lead.country, lead.assignedById, this.initialStatusId,
        this.label(f, 'leadTypeId'), this.label(f, 'regionId'),
        this.label(f, 'productInterestId'), this.label(f, 'priorityId'),
        JSON.stringify(phones), JSON.stringify(emails),
        lead.verbatim, lead.aiSummaryRu, lead.service.teamsAuthor,
      );
    const row = this.db.handle.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    this.linkSource(row.id, lead.localId);
    return row.id;
  }

  /** Update the merged lead. `status_id` is deliberately left alone. */
  private update(id: number, lead: LeadWrite, phones: string[], emails: string[]): void {
    const f = lead.listFields as unknown as Record<string, unknown>;
    const existing = this.db.handle
      .prepare('SELECT phones_json, emails_json FROM platform_leads WHERE id = ?')
      .get(id) as { phones_json: string; emails_json: string } | undefined;

    // Union the comms so a follow-up message adds a number instead of losing one.
    const mergedPhones = unique([...parseComm(existing?.phones_json ?? '[]'), ...phones]);
    const mergedEmails = unique([...parseComm(existing?.emails_json ?? '[]'), ...emails]);

    this.db.handle
      .prepare(
        `UPDATE platform_leads SET
           title = COALESCE(?, title), name = COALESCE(?, name),
           company = COALESCE(?, company), position = COALESCE(?, position),
           country = COALESCE(?, country), owner_id = COALESCE(?, owner_id),
           lead_type = COALESCE(?, lead_type), region = COALESCE(?, region),
           product_interest = COALESCE(?, product_interest),
           priority = COALESCE(?, priority),
           phones_json = ?, emails_json = ?,
           verbatim = COALESCE(?, verbatim), ai_summary = COALESCE(?, ai_summary),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        lead.title, lead.name, lead.company, lead.position, lead.country, lead.assignedById,
        this.label(f, 'leadTypeId'), this.label(f, 'regionId'),
        this.label(f, 'productInterestId'), this.label(f, 'priorityId'),
        JSON.stringify(mergedPhones), JSON.stringify(mergedEmails),
        lead.verbatim, lead.aiSummaryRu, id,
      );
    // The later message contributed to this lead too. Without this the console
    // kept showing only the first session, so a follow-up looked unprocessed.
    this.linkSource(id, lead.localId);
  }

  /** Note that a pipeline row contributed to a platform lead. */
  private linkSource(platformLeadId: number, localId: string): void {
    this.db.handle
      .prepare('INSERT OR IGNORE INTO platform_lead_sources (platform_lead_id, local_id) VALUES (?, ?)')
      .run(platformLeadId, localId);
  }
}

/* ── helpers ─────────────────────────────────────────────────── */

/**
 * `LeadListFields` carries Bitrix list-value IDs under camelCase keys
 * (`leadTypeId`, `priorityId`, ...). The platform stores the readable label
 * instead, resolved back through the same seeded catalog the mapper used.
 */
const LIST_KEY_TO_FIELD: Record<string, string> = {
  leadTypeId: 'UF_CRM_LEAD_TYPE',
  regionId: 'UF_CRM_REGION',
  productInterestId: 'UF_CRM_PRODUCT_INTEREST',
  priorityId: 'UF_CRM_PRIORITY',
};



function parseComm(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const unique = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));
