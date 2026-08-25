/**
 * Backfill the platform lead store from leads the pipeline already processed.
 *
 * Everything needed is already persisted on each `leads` row (gated extraction,
 * mapped list ids, verbatim, summary) plus the session for the Teams author, so
 * this replays them into `platform_leads` through the normal store — meaning the
 * same duplicate-merge rules apply and a re-run is safe (it merges, not doubles).
 *
 * Usage:
 *   npx tsx scripts/backfill-platform.ts          # dry run — reports only
 *   npx tsx scripts/backfill-platform.ts --write  # actually insert
 */

import { loadConfig } from '../server/src/config/index.js';
import { Db } from '../server/src/db/index.js';
import { PlatformLeadStore } from '../server/src/platform/store.js';
import { resolveOwner } from '../server/src/identity/index.js';
import type { LeadWrite } from '../server/src/contracts/index.js';

interface StoredFields {
  gated?: Record<string, unknown>;
  listFields?: Record<string, unknown>;
  messageIds?: string[];
}

function parse(json: string | null): StoredFields | null {
  if (!json) return null;
  try { return JSON.parse(json) as StoredFields; } catch { return null; }
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const store = new PlatformLeadStore({ db, initialStatusId: cfg.bitrixInitialStatusId });

  const existing = new Set(
    (db.handle.prepare('SELECT local_id FROM platform_leads').all() as Array<{ local_id: string }>)
      .map((r) => r.local_id),
  );

  const rows = db.listLeads();
  const writes: LeadWrite[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (existing.has(row.id)) { skipped++; continue; }
    const fields = parse(row.fields_json);
    const gated = fields?.gated as Record<string, unknown> | undefined;
    if (!gated) { skipped++; continue; }

    const session = db.getSession(row.session_id);
    if (!session) { skipped++; continue; }
    const owner = resolveOwner(db, session.author_email, cfg.bitrixDefaultOwnerId);

    const phones = (gated['phones'] as Array<{ value: string; type: string }> | undefined) ?? [];
    const emails = (gated['emails'] as Array<{ value: string; type: string }> | undefined) ?? [];

    writes.push({
      localId: row.id,
      sessionId: row.session_id,
      title: row.title ?? '',
      assignedById: owner.ownerId,
      name: (gated['name'] as string) ?? null,
      company: (gated['company'] as string) ?? null,
      position: (gated['position'] as string) ?? null,
      country: (gated['country'] as string) ?? null,
      phones: phones.map((p) => ({ value: p.value, type: p.type })),
      emails: emails.map((e) => ({ value: e.value, type: e.type })),
      listFields: (fields?.listFields ?? {}) as unknown as LeadWrite['listFields'],
      verbatim: row.transcript_verbatim ?? '',
      aiSummaryRu: row.ai_summary_ru ?? '',
      service: {
        teamsGroupId: '',
        teamsMessageIds: fields?.messageIds ?? [],
        teamsAuthor: session.author_email,
      },
      warnings: (parse(row.warnings_json) as unknown as string[]) ?? [],
      needsAttachmentRetry: row.needs_attachment_retry === 1,
    });
  }

  console.log(`leads on file: ${rows.length}`);
  console.log(`already in platform store: ${skipped}`);
  console.log(`to backfill: ${writes.length}`);

  if (!write) {
    for (const w of writes.slice(0, 10)) console.log(`  • ${w.title || '(untitled)'} — owner ${w.assignedById}`);
    if (writes.length > 10) console.log(`  ... and ${writes.length - 10} more`);
    console.log('\nDry run. Re-run with --write to insert.');
    db.close();
    return;
  }

  const results = await store.writeLeads(writes);

  // Carry the ORIGINAL capture time across. Without this every backfilled lead
  // is stamped "now" and the leads-over-time chart shows one meaningless spike
  // on the migration day instead of when the leads actually came in.
  const originalTime = new Map(rows.map((r) => [r.id, r.created_at]));
  const stamp = db.handle.prepare('UPDATE platform_leads SET created_at = ? WHERE local_id = ?');
  let restamped = 0;
  for (const r of results) {
    const when = originalTime.get(r.localId);
    if (r.bitrixLeadId != null && !r.updatedExisting && when) {
      stamp.run(when, r.localId);
      restamped++;
    }
  }

  const added = results.filter((r) => r.bitrixLeadId != null && !r.updatedExisting).length;
  const merged = results.filter((r) => r.updatedExisting).length;
  const failed = results.filter((r) => r.error != null);
  console.log(`\ncapture times restored: ${restamped}`);

  console.log(`\nadded:  ${added}`);
  console.log(`merged: ${merged} (same manager + same phone/email)`);
  if (failed.length) {
    console.log(`failed: ${failed.length}`);
    for (const f of failed.slice(0, 5)) console.log(`  ! ${f.localId}: ${f.error}`);
  }
  db.close();
}

main().catch((e) => {
  console.error('BACKFILL FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
