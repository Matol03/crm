/**
 * Link historical pipeline rows to the platform lead they contributed to.
 *
 * Leads merged before platform_lead_sources existed kept only their first
 * contributing row, so everything a later message added — its interest, its
 * warnings, its source messages — was invisible in the console.
 *
 * Matching rule: the row's extracted NAME must equal the platform lead's name,
 * AND they must share a phone or e-mail. Contact details alone are not enough:
 * placeholder numbers collide, and a wrong link would attach one person's
 * evidence to another's lead — worse than leaving it unlinked.
 *
 * Usage:  npx tsx scripts/repair-lead-sources.ts [--write]
 */

import { loadConfig } from '../server/src/config/index.js';
import { Db } from '../server/src/db/index.js';

const write = process.argv.includes('--write');
const cfg = loadConfig();
const db = new Db(cfg.dbPath);

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const digits = (s: string) => s.replace(/\D/g, '');

const linked = new Set(
  (db.handle.prepare('SELECT local_id FROM platform_lead_sources').all() as Array<{ local_id: string }>)
    .map((r) => r.local_id),
);

const platform = (db.handle
  .prepare('SELECT id, name, phones_json, emails_json FROM platform_leads')
  .all() as Array<{ id: number; name: string | null; phones_json: string; emails_json: string }>)
  .map((p) => ({
    id: p.id,
    name: norm(p.name),
    phones: new Set((JSON.parse(p.phones_json || '[]') as string[]).map(digits).filter((x) => x.length >= 5)),
    emails: new Set((JSON.parse(p.emails_json || '[]') as string[]).map(norm).filter(Boolean)),
  }));

let linkedCount = 0;
let skipped = 0;

for (const row of db.listLeads()) {
  if (linked.has(row.id)) continue;
  const gated = (JSON.parse(row.fields_json || '{}').gated ?? {}) as {
    name?: string | null;
    phones?: Array<{ value: string }>;
    emails?: Array<{ value: string }>;
  };
  const name = norm(gated.name);
  const phones = new Set((gated.phones ?? []).map((p) => digits(p.value)).filter((x) => x.length >= 5));
  const emails = new Set((gated.emails ?? []).map((e) => norm(e.value)).filter(Boolean));

  const matches = platform.filter(
    (p) =>
      p.name && name && p.name === name &&
      ([...phones].some((x) => p.phones.has(x)) || [...emails].some((x) => p.emails.has(x))),
  );

  if (matches.length !== 1) {
    skipped++;
    console.log(`  skip  ${row.id.slice(-22)}  ${String(row.title).slice(0, 34)!}  (${matches.length} matches)`);
    continue;
  }
  const target = matches[0]!;
  console.log(`  link  ${row.id.slice(-22)}  ->  lead #${target.id}`);
  if (write) {
    db.handle
      .prepare('INSERT OR IGNORE INTO platform_lead_sources (platform_lead_id, local_id) VALUES (?, ?)')
      .run(target.id, row.id);
  }
  linkedCount++;
}

console.log(`\nlinked: ${linkedCount}   skipped: ${skipped}`);
if (!write) console.log('Dry run. Re-run with --write to apply.');
db.close();
