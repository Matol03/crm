/**
 * Record the Bitrix id of leads whose portal copy exists but was never linked.
 *
 * Leads imported by the backfill were written straight to the platform store,
 * so their portal id was never recorded — even though the portal copy exists
 * from the original run. Deleting such a lead left the copy behind.
 *
 * Every candidate is VERIFIED against the portal before being recorded: the
 * pipeline row's `bitrix_lead_id` means different things for different eras
 * (a portal id before the platform sink, a platform id after), so an unverified
 * value would point at an unrelated lead and a later delete would remove the
 * wrong record.
 *
 * Usage:  npx tsx scripts/repair-portal-ids.ts [--write]
 */

import { loadConfig } from '../server/src/config/index.js';
import { buildApp } from '../server/src/app.js';
import { RealBitrixClient } from '../server/src/bitrix/real.js';
import { RateLimiter } from '../server/src/bitrix/rateLimiter.js';
import { createHttpTransport } from '../server/src/bitrix/transport.js';

const write = process.argv.includes('--write');
const cfg = loadConfig();
const { db } = buildApp(cfg, cfg.dbPath);

const portal = new RealBitrixClient({
  webhookUrl: cfg.bitrixWebhookUrl,
  rateLimiter: new RateLimiter({ ratePerSec: cfg.bitrixRateLimitPerSec }),
  transport: createHttpTransport(cfg.bitrixWebhookUrl),
  batchSize: cfg.bitrixBatchSize,
  initialStatusId: cfg.bitrixInitialStatusId,
});

const digits = (s: string) => s.replace(/\D/g, '');
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

const rows = db.handle.prepare(`
  SELECT p.id AS pid, p.name, p.phones_json, p.emails_json,
         (SELECT group_concat(l.bitrix_lead_id)
            FROM platform_lead_sources s JOIN leads l ON l.id = s.local_id
           WHERE s.platform_lead_id = p.id AND l.bitrix_lead_id IS NOT NULL) AS candidates
    FROM platform_leads p
   WHERE p.bitrix_lead_id IS NULL
   ORDER BY p.id
`).all() as Array<{
  pid: number; name: string | null; phones_json: string; emails_json: string; candidates: string | null;
}>;

let recorded = 0;
let unresolved = 0;

for (const r of rows) {
  const phones = (JSON.parse(r.phones_json || '[]') as string[]);
  const emails = (JSON.parse(r.emails_json || '[]') as string[]);
  const ourPhones = new Set(phones.map(digits).filter((x) => x.length >= 5));
  const ourEmails = new Set(emails.map(norm).filter(Boolean));

  /** Does this portal lead really correspond to ours? */
  const verify = async (id: number): Promise<boolean> => {
    const lead = await portal.getLead(id);
    if (!lead) return false;
    const f = lead.fields as Record<string, unknown>;
    const title = norm(f['TITLE']) + ' ' + norm(f['NAME']) + ' ' + norm(f['LAST_NAME']);
    const nameMatch = !!r.name && title.includes(norm(r.name).split(' ')[0] ?? '');
    const comm = [
      ...(Array.isArray(f['PHONE']) ? (f['PHONE'] as Array<{ VALUE?: string }>) : []).map((p) => digits(String(p.VALUE ?? ''))),
      ...(Array.isArray(f['EMAIL']) ? (f['EMAIL'] as Array<{ VALUE?: string }>) : []).map((e) => norm(e.VALUE)),
    ];
    const commMatch = comm.some((v) => ourPhones.has(v) || ourEmails.has(v));
    // Name AND a shared contact detail: either alone has produced wrong matches.
    return nameMatch && commMatch;
  };

  let found: number | null = null;
  for (const id of [...new Set((r.candidates ?? '').split(',').filter(Boolean).map(Number))]) {
    if (await verify(id)) { found = id; break; }
  }
  // Nothing verified: ask the portal to find it by contact details.
  if (found == null && (phones.length || emails.length)) {
    const match = await portal.findDuplicate({ phones, emails }).catch(() => null);
    if (match && (await verify(match.bitrixLeadId))) found = match.bitrixLeadId;
  }

  if (found == null) {
    unresolved++;
    console.log(`  unresolved  platform #${r.pid}  ${String(r.name).slice(0, 26)}`);
    continue;
  }
  console.log(`  record      platform #${r.pid}  ${String(r.name).slice(0, 26).padEnd(26)} -> portal #${found}`);
  if (write) {
    db.handle
      .prepare(`UPDATE platform_leads SET bitrix_lead_id = ?, bitrix_synced_at = datetime('now') WHERE id = ?`)
      .run(found, r.pid);
  }
  recorded++;
}

console.log(`\nrecorded: ${recorded}   unresolved: ${unresolved}`);
if (!write) console.log('Dry run. Re-run with --write to apply.');
db.close();
