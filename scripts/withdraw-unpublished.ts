/**
 * Remove the Bitrix24 copies of leads that are not marked Completed.
 *
 * Leads created before publishing moved to completion already have portal
 * copies, even though nobody has accepted them. This withdraws those copies so
 * the CRM holds only leads a person approved. The leads stay on the platform —
 * they simply have no CRM record until someone completes them.
 *
 * Only leads that exist on this platform are considered. Portal leads with no
 * counterpart here are left alone: they are not this script's to judge.
 *
 * Usage:  npx tsx scripts/withdraw-unpublished.ts [--write]
 */

import { loadConfig } from '../server/src/config/index.js';
import { buildApp } from '../server/src/app.js';
import { DualLeadSink } from '../server/src/platform/dual.js';

const write = process.argv.includes('--write');
const cfg = loadConfig();
const { bitrix, db } = buildApp(cfg, cfg.dbPath);

if (!(bitrix instanceof DualLeadSink)) {
  console.error('This needs LEAD_SINK=both so the portal is reachable.');
  process.exit(1);
}

const COMPLETED = 'CONVERTED';
const rows = db.handle
  .prepare('SELECT id, name, status_id, bitrix_lead_id FROM platform_leads ORDER BY id')
  .all() as Array<{ id: number; name: string | null; status_id: string; bitrix_lead_id: number | null }>;

let removed = 0;
let planned = 0;
let kept = 0;
const failures: string[] = [];

for (const r of rows) {
  if (r.status_id === COMPLETED) {
    if (r.bitrix_lead_id != null) kept++;
    continue;
  }
  const copies = await bitrix.resolvePortalIds(r.id);
  if (!copies.length) continue;

  const label = `platform #${String(r.id).padEnd(3)} ${String(r.name).slice(0, 22).padEnd(22)} [${r.status_id}]`;
  console.log(`  ${write ? 'removing' : 'would remove'}  ${label} -> portal ${copies.map((c) => '#' + c).join(', ')}`);
  planned += copies.length;
  if (!write) continue;

  const result = await bitrix.withdrawFromPortal(r.id);
  removed += result.removed.length;
  failures.push(...result.failures);
}

console.log(`\n${write ? 'removed' : 'to remove'}: ${write ? removed : planned} portal copies`);
console.log(`kept (already Completed): ${kept}`);
if (failures.length) console.log(`failures: ${failures.join('; ')}`);
if (!write) console.log('\nDry run. Re-run with --write to apply.');
db.close();
