/**
 * ONE controlled live Bitrix write (owner-approved). Processes a single fixture
 * through the real pipeline (live Gemini extraction + LIVE Bitrix write), then
 * reads the lead back to confirm. Guarded: refuses to run unless BITRIX_MODE=live.
 *
 * Usage: BITRIX_MODE=live tsx scripts/live-write-test.ts [fixture-name]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, redactedSummary } from '../server/src/config/index.js';
import { buildApp } from '../server/src/app.js';
import { portalOrigin } from '../server/src/bitrix/transport.js';
import type { SessionBundle } from '../server/src/contracts/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCEN_DIR = resolve(ROOT, 'fixtures/scenarios');

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.bitrixMode !== 'live') {
    throw new Error('refusing to write: run with BITRIX_MODE=live (this creates a REAL lead)');
  }
  console.log('Config:', JSON.stringify(redactedSummary(cfg)));
  console.log('LIVE WRITE to portal:', portalOrigin(cfg.bitrixWebhookUrl), '| default owner:', cfg.bitrixDefaultOwnerId);

  const name = process.argv[2] ?? 'text-first-then-card';
  const bundle = JSON.parse(readFileSync(resolve(SCEN_DIR, `${name}.json`), 'utf8')) as SessionBundle;
  console.log(`\nProcessing fixture "${name}" (${bundle.items.length} messages) ...`);

  const { pipeline, bitrix } = buildApp(cfg, ':memory:');
  const res = await pipeline.processSession(bundle);

  console.log(`\nstatus=${res.status}`);
  if (res.error) console.log('error:', res.error);
  console.log('reply:', res.replyText);
  for (const l of res.leads) {
    console.log(`\nlead: ${l.title}`);
    console.log(`  bitrixLeadId: ${l.bitrixLeadId}`);
    if (l.warnings.length) console.log(`  warnings: ${l.warnings.join('; ')}`);
    if (l.bitrixLeadId != null) {
      console.log(`  URL: ${bitrix.leadUrl(l.bitrixLeadId)}`);
      const record = await bitrix.getLead(l.bitrixLeadId);
      const f = record?.fields ?? {};
      console.log('  read-back:', JSON.stringify({
        TITLE: f.TITLE, NAME: f.NAME, COMPANY_TITLE: f.COMPANY_TITLE,
        ASSIGNED_BY_ID: f.ASSIGNED_BY_ID, UF_CRM_LEAD_TYPE: f.UF_CRM_LEAD_TYPE,
        UF_CRM_EXHIBITION: f.UF_CRM_EXHIBITION, UF_CRM_TEAMS_AUTHOR: f.UF_CRM_TEAMS_AUTHOR,
      }));
    }
  }
}

main().catch((e) => {
  console.error('LIVE WRITE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
