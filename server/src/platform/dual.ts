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

/** Optional portal capabilities used to locate copies we did not record. */
export interface PortalLookup {
  findServiceLeadsByTitle?(title: string): Promise<number[]>;
}

export interface DualSinkOptions {
  db: Db;
  platform: PlatformLeadStore;
  bitrix: BitrixClient & PortalLookup;
  /** Structured, PII-free notice when the mirror fails (S13). */
  onWarn?: (e: { event: string; localId: string; detail: string }) => void;
  /** Remove the portal copy when a lead is rejected here. Default true. */
  deleteOnReject?: boolean;
  /**
   * When a lead reaches the portal.
   *   'on_complete' — only once an operator marks it Completed (default)
   *   'immediate'   — as soon as the pipeline creates it
   */
  publish?: 'on_complete' | 'immediate';
}

/** The stage at which a lead is considered accepted and sent to the portal. */
const COMPLETED_STATUS = 'CONVERTED';

export class DualLeadSink implements BitrixClient {
  private readonly db: Db;
  private readonly platform: PlatformLeadStore;
  private readonly bitrix: BitrixClient & PortalLookup;
  private readonly onWarn: (e: { event: string; localId: string; detail: string }) => void;
  private readonly deleteOnReject: boolean;
  private readonly publish: 'on_complete' | 'immediate';

  constructor(opts: DualSinkOptions) {
    this.db = opts.db;
    this.platform = opts.platform;
    this.bitrix = opts.bitrix;
    this.onWarn = opts.onWarn ?? (() => {});
    this.deleteOnReject = opts.deleteOnReject ?? true;
    this.publish = opts.publish ?? 'on_complete';
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

    // 2. Nothing goes to the portal yet under 'on_complete'. A freshly
    // extracted lead has not been looked at by anyone; publishing it
    // immediately fills the CRM with records the sales team has to sort out,
    // which is the opposite of what this service is for. It is published when
    // an operator marks it Completed — see setLeadStatus.
    if (this.publish === 'on_complete') return primary;

    // Mirror only what actually landed locally.
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
    if (!row) return;

    // Completing a lead is what sends it to the portal. This is the only point
    // at which a lead is created there, so a record only ever reaches the sales
    // team after a person has looked at it and accepted it.
    if (statusId === COMPLETED_STATUS && row.bitrix_lead_id == null) {
      await this.publishToPortal(id, row.local_id);
      return;
    }

    // Same recovery as deletion: an unrecorded id does not mean no copy exists.
    const portalId = row.bitrix_lead_id ?? (await this.resolvePortalIds(id))[0] ?? null;
    if (portalId == null || !this.bitrix.setLeadStatus) return;
    row.bitrix_lead_id = portalId;

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
    // Resolve the portal copy BEFORE the local row is gone: afterwards there is
    // nothing left to look it up by.
    const bitrixIds = await this.resolvePortalIds(id);
    await this.platform.deleteLead(id);

    if (!this.bitrix.deleteLead) return;
    if (bitrixIds.length === 0) {
      // Previously this returned silently and the portal copy was left behind
      // with no indication. Say so: an orphan the sales team still works is
      // exactly what deleting was meant to prevent.
      this.onWarn({ event: 'bitrix_copy_not_found', localId: String(id), detail: 'no portal id known' });
      throw new Error(
        'Lead removed here, but no matching lead was found in Bitrix24 — check the portal manually.',
      );
    }
    const failures: string[] = [];
    for (const bitrixId of bitrixIds) {
      try {
        await this.bitrix.deleteLead(bitrixId);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.onWarn({ event: 'bitrix_delete_failed', localId: String(id), detail });
        failures.push(`#${bitrixId}: ${detail}`);
      }
    }
    if (failures.length) {
      throw new Error(`Lead removed here, but not in Bitrix24 — ${failures.join('; ')}`);
    }
  }

  /**
   * Every portal copy of a lead. Public so cleanup tooling applies exactly the
   * same rules — including the guards — rather than reimplementing them.
   *
   * Leads created before this service recorded the mirror id — and any whose
   * mirror write failed — have no stored id, yet a copy may well exist in the
   * portal. Falling straight through to "nothing to delete" leaves that copy
   * behind, so ask the portal to find it by contact details, which is how it
   * was matched in the first place.
   */
  async resolvePortalIds(id: number): Promise<number[]> {
    const found = new Set<number>();

    // 1. The id recorded when the copy was written, if we have one.
    const stored = this.platform.bitrixIdFor(id);
    if (stored != null) found.add(stored);

    // 2. By contact details — how the copy was matched when it was written.
    const comm = this.platform.commsFor(id);
    if (comm.phones.length || comm.emails.length) {
      try {
        const match = await this.bitrix.findDuplicate(comm);
        if (match) found.add(match.bitrixLeadId);
      } catch {
        // A lookup failure must not be read as "there is no copy".
      }
    }

    // 3. By title. Two reasons this runs even when a stored id exists: a lead
    // captured with no phone and no e-mail cannot be found by the duplicate
    // search at all, AND the portal genuinely holds several copies of some
    // leads. Stopping at the recorded id removed one copy and left the rest —
    // which is what "deleted here but still in Bitrix" looked like.
    //
    // Restricted to leads this service created, so a hand-entered lead is never
    // returned; and skipped when another platform lead shares the title, so
    // deleting one lead cannot take another lead's copies with it.
    const title = this.platform.titleFor(id);
    if (title && this.bitrix.findServiceLeadsByTitle && this.platform.countWithTitle(title) <= 1) {
      try {
        for (const other of await this.bitrix.findServiceLeadsByTitle(title)) found.add(other);
      } catch {
        /* keep whatever the earlier steps found */
      }
    }
    return [...found];
  }

  /**
   * Create the lead in the portal, now that an operator has accepted it.
   *
   * The record is rebuilt from the stored lead rather than kept in memory: a
   * lead may be completed days after it was extracted. A failure here is
   * reported to the caller AND recorded on the lead, because the operator
   * needs to know the CRM did not receive what they just approved.
   */
  private async publishToPortal(id: number, localId: string): Promise<void> {
    const write = this.platform.toLeadWrite(id);
    if (!write) return;

    let results;
    try {
      results = await this.bitrix.writeLeads([write]);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.recordMirror(localId, null, `not sent to Bitrix24: ${detail}`);
      this.onWarn({ event: 'bitrix_publish_failed', localId, detail });
      throw new Error(`Marked Completed here, but not created in Bitrix24: ${detail}`);
    }

    const result = results[0];
    if (!result || result.bitrixLeadId == null || result.error) {
      const detail = result?.error ?? 'the portal did not return a lead id';
      this.recordMirror(localId, null, `not sent to Bitrix24: ${detail}`);
      this.onWarn({ event: 'bitrix_publish_failed', localId, detail });
      throw new Error(`Marked Completed here, but not created in Bitrix24: ${detail}`);
    }

    this.recordMirror(localId, result.bitrixLeadId, null);
    // The portal defaults a new lead to its own initial status, so state the
    // agreed one explicitly — the lead is complete, not new.
    if (this.bitrix.setLeadStatus) {
      try {
        await this.bitrix.setLeadStatus(result.bitrixLeadId, COMPLETED_STATUS);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.recordMirror(localId, result.bitrixLeadId, `status not synced: ${detail}`);
        this.onWarn({ event: 'bitrix_status_sync_failed', localId, detail });
      }
    }
  }

  /**
   * Fold one lead into another locally, then remove every portal copy of the
   * absorbed duplicate. Leaving those behind is precisely the duplicate the
   * merge was meant to resolve.
   */
  async mergeLeads(survivorId: number, duplicateId: number): Promise<void> {
    // Resolve BEFORE the row is merged away: afterwards there is nothing left
    // to look the copies up by.
    const duplicateBitrixIds = await this.resolvePortalIds(duplicateId);
    await this.platform.mergeLeads(survivorId, duplicateId);

    if (!this.bitrix.deleteLead) return;
    if (duplicateBitrixIds.length === 0) {
      this.onWarn({ event: 'bitrix_copy_not_found', localId: String(duplicateId), detail: 'no portal copy found' });
      throw new Error(
        'Leads merged here, but no matching duplicate was found in Bitrix24 — check the portal manually.',
      );
    }

    const failures: string[] = [];
    for (const bid of duplicateBitrixIds) {
      try {
        await this.bitrix.deleteLead(bid);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.onWarn({ event: 'bitrix_delete_failed', localId: String(duplicateId), detail });
        failures.push(`#${bid}: ${detail}`);
      }
    }
    if (failures.length) {
      throw new Error(`Leads merged here, but the duplicate remains in Bitrix24 — ${failures.join('; ')}`);
    }
  }

  /**
   * Remove a lead's portal copies while keeping the lead here.
   *
   * Used to withdraw records that reached the CRM before publishing moved to
   * completion. Unlike deleteLead this does not touch the local lead: it is
   * still a lead, it simply has no CRM record until someone accepts it.
   */
  async withdrawFromPortal(id: number): Promise<{ removed: number[]; failures: string[] }> {
    const copies = await this.resolvePortalIds(id);
    const removed: number[] = [];
    const failures: string[] = [];
    if (!copies.length || !this.bitrix.deleteLead) return { removed, failures };

    for (const copy of copies) {
      try {
        await this.bitrix.deleteLead(copy);
        removed.push(copy);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.onWarn({ event: 'bitrix_delete_failed', localId: String(id), detail });
        failures.push(`#${copy}: ${detail}`);
      }
    }
    // Clear the link only for copies that actually went, so a failed one is
    // still found next time rather than being forgotten about.
    if (removed.length && !failures.length) {
      this.db.handle
        .prepare(`UPDATE platform_leads
                     SET bitrix_lead_id = NULL, bitrix_synced_at = NULL, bitrix_error = NULL
                   WHERE id = ?`)
        .run(id);
    }
    return { removed, failures };
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
