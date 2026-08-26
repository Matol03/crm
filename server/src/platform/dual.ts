/**
 * Dual lead sink (LEAD_SINK=both): every lead is stored on the platform AND
 * mirrored to Bitrix24.
 *
 * The platform is the PRIMARY record and Bitrix is a best-effort mirror. That
 * ordering is deliberate: the local write cannot fail for network reasons, so a
 * portal outage, an expired webhook, or a rate-limit degrades the mirror
 * without ever losing the lead. A failed mirror is recorded on the row and
 * surfaced in the console — never silently swallowed, and never thrown, which
 * would fail the whole session and re-run extraction on the next poll.
 *
 * The id returned to the pipeline is the PLATFORM id, because the console reads
 * and links by it. The Bitrix id is stored alongside so the UI can still offer
 * "open in Bitrix" for leads that made it across.
 */

import type {
  BitrixClient,
  BitrixLeadRecord,
  DuplicateMatch,
  LeadWrite,
  LeadWriteResult,
} from '../contracts/bitrix.js';
import type { Db } from '../db/index.js';
import type { PlatformLeadStore } from './store.js';

export interface DualSinkOptions {
  db: Db;
  platform: PlatformLeadStore;
  bitrix: BitrixClient;
  /** Structured, PII-free notice when the mirror fails (S13). */
  onWarn?: (e: { event: string; localId: string; detail: string }) => void;
  /** Remove the portal copy when a lead is rejected here. Default true. */
  deleteOnReject?: boolean;
}

export class DualLeadSink implements BitrixClient {
  private readonly db: Db;
  private readonly platform: PlatformLeadStore;
  private readonly bitrix: BitrixClient;
  private readonly onWarn: (e: { event: string; localId: string; detail: string }) => void;
  private readonly deleteOnReject: boolean;

  constructor(opts: DualSinkOptions) {
    this.db = opts.db;
    this.platform = opts.platform;
    this.bitrix = opts.bitrix;
    this.onWarn = opts.onWarn ?? (() => {});
    this.deleteOnReject = opts.deleteOnReject ?? true;
  }

  /**
   * List values come from the PORTAL, so the ids written to Bitrix are the
   * portal's real ones. The platform resolves those ids back to labels through
   * the same cache, so both sides agree.
   */
  async listUserFieldValues(fieldCode: string): Promise<Array<{ label: string; id: number }>> {
    try {
      return await this.bitrix.listUserFieldValues(fieldCode);
    } catch {
      // Portal unreachable — fall back to what the platform knows, so mapping
      // still works and the lead is still stored with readable labels.
      return this.platform.listUserFieldValues(fieldCode);
    }
  }

  /**
   * Deduplicate against the PLATFORM, the complete local record. Bitrix may be
   * missing leads whose mirror failed, so asking it could re-create a duplicate
   * that the platform already holds.
   */
  async findDuplicate(comm: { phones: string[]; emails: string[] }): Promise<DuplicateMatch | null> {
    return this.platform.findDuplicate(comm);
  }

  async writeLeads(leads: LeadWrite[]): Promise<LeadWriteResult[]> {
    // 1. Primary write. Never skipped, never conditional.
    const primary = await this.platform.writeLeads(leads);

    // 2. Mirror only what actually landed locally.
    const mirrorable = leads.filter((l) =>
      primary.some((r) => r.localId === l.localId && r.bitrixLeadId != null && r.error == null),
    );
    if (mirrorable.length === 0) return primary;

    let mirrored: LeadWriteResult[] = [];
    try {
      mirrored = await this.bitrix.writeLeads(mirrorable);
    } catch (e) {
      // A whole-batch failure (auth, network) — record it against each lead.
      const detail = e instanceof Error ? e.message : String(e);
      for (const l of mirrorable) this.recordMirror(l.localId, null, detail);
      this.onWarn({ event: 'bitrix_mirror_failed', localId: `${mirrorable.length} lead(s)`, detail });
      return primary;
    }

    for (const m of mirrored) {
      this.recordMirror(m.localId, m.bitrixLeadId, m.error);
      if (m.error) {
        this.onWarn({ event: 'bitrix_mirror_failed', localId: m.localId, detail: m.error });
      }
    }
    return primary;
  }

  /** The platform holds the canonical record, so reads come from it. */
  async getLead(id: number): Promise<BitrixLeadRecord | null> {
    return this.platform.getLead(id);
  }

  leadUrl(id: number): string {
    return this.platform.leadUrl(id);
  }

  /**
   * Change status locally first, then mirror. Same rule as writing: the local
   * record must reflect the operator's action even if the portal rejects it,
   * and the mirror failure is recorded rather than thrown.
   */
  async setLeadStatus(id: number, statusId: string): Promise<void> {
    await this.platform.setLeadStatus(id, statusId);

    const row = this.db.handle
      .prepare('SELECT local_id, bitrix_lead_id FROM platform_leads WHERE id = ?')
      .get(id) as { local_id: string; bitrix_lead_id: number | null } | undefined;
    if (!row?.bitrix_lead_id || !this.bitrix.setLeadStatus) return;

    // Rejecting a lead here removes it from the portal rather than leaving a
    // rejected copy for the sales team to work. Configurable via deleteOnReject.
    if (statusId === 'JUNK' && this.deleteOnReject && this.bitrix.deleteLead) {
      try {
        await this.bitrix.deleteLead(row.bitrix_lead_id);
        this.db.handle
          .prepare(`UPDATE platform_leads SET bitrix_lead_id = NULL, bitrix_error = NULL,
                     bitrix_synced_at = datetime('now') WHERE local_id = ?`)
          .run(row.local_id);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.recordMirror(row.local_id, row.bitrix_lead_id, `not removed from Bitrix24: ${detail}`);
        this.onWarn({ event: 'bitrix_delete_failed', localId: row.local_id, detail });
      }
      return;
    }

    try {
      await this.bitrix.setLeadStatus(row.bitrix_lead_id, statusId);
      this.recordMirror(row.local_id, row.bitrix_lead_id, null);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.recordMirror(row.local_id, row.bitrix_lead_id, `status not synced: ${detail}`);
      this.onWarn({ event: 'bitrix_status_sync_failed', localId: row.local_id, detail });
    }
  }

  /**
   * Delete locally AND in the portal. The portal copy exists only because this
   * service put it there, so removing the lead here without removing it there
   * would leave an orphan the sales team still works.
   *
   * The portal call is best-effort in the same sense as writing: if it fails,
   * the local deletion still stands and the failure is reported to the caller,
   * because silently keeping a lead the operator asked to delete is worse.
   */
  async deleteLead(id: number): Promise<void> {
    const bitrixId = this.platform.bitrixIdFor(id);
    await this.platform.deleteLead(id);

    if (bitrixId == null || !this.bitrix.deleteLead) return;
    try {
      await this.bitrix.deleteLead(bitrixId);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.onWarn({ event: 'bitrix_delete_failed', localId: String(id), detail });
      throw new Error(`Lead removed here, but not in Bitrix24: ${detail}`);
    }
  }

  /** Fold one lead into another locally, then remove the duplicate's portal copy. */
  async mergeLeads(survivorId: number, duplicateId: number): Promise<void> {
    const duplicateBitrixId = this.platform.bitrixIdFor(duplicateId);
    await this.platform.mergeLeads(survivorId, duplicateId);

    if (duplicateBitrixId == null || !this.bitrix.deleteLead) return;
    try {
      await this.bitrix.deleteLead(duplicateBitrixId);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.onWarn({ event: 'bitrix_delete_failed', localId: String(duplicateId), detail });
      throw new Error(`Leads merged here, but the duplicate remains in Bitrix24: ${detail}`);
    }
  }

  /** Portal URL for a mirrored lead, for the console's outbound link. */
  bitrixUrlFor(bitrixLeadId: number): string {
    return this.bitrix.leadUrl(bitrixLeadId);
  }

  private recordMirror(localId: string, bitrixLeadId: number | null, error: string | null): void {
    this.db.handle
      .prepare(
        `UPDATE platform_leads
            SET bitrix_lead_id   = COALESCE(?, bitrix_lead_id),
                bitrix_synced_at = CASE WHEN ? IS NULL THEN bitrix_synced_at ELSE datetime('now') END,
                bitrix_error     = ?
          WHERE local_id = ?`,
      )
      .run(bitrixLeadId, bitrixLeadId, error, localId);
  }
}
