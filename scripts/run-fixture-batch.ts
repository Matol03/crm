/**
 * Feed fixtures straight into the pipeline against mock Bitrix — the demo run
 * (PRD Section 17). No live Teams, no manual insertion of intermediate data.
 * Prints per-session results and Section-15 metrics scored against
 * ground-truth.json.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config/index.js';
import { buildMockApp } from '../server/src/app.js';
import type { SessionBundle } from '../server/src/contracts/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCEN_DIR = resolve(ROOT, 'fixtures/scenarios');
const GT_PATH = resolve(ROOT, 'fixtures/ground-truth.json');

interface GtSession {
  name: string;
  sessionId: string;
  expectedLeadCount: number;
  isNonLead: boolean;
}

function loadBundles(): SessionBundle[] {
  return readdirSync(SCEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(SCEN_DIR, f), 'utf8')) as SessionBundle);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { pipeline, graph, bitrix } = buildMockApp(cfg);
  const bundles = loadBundles();
  const gt = JSON.parse(readFileSync(GT_PATH, 'utf8')) as { sessions: GtSession[] };
  const gtById = new Map(gt.sessions.map((s) => [s.sessionId, s]));

  console.log(`\n=== Fixture batch: ${bundles.length} sessions (mock Bitrix) ===\n`);

  let leadCountCorrect = 0;
  let sessionsScored = 0;
  let totalLeadsCreated = 0;

  for (const bundle of bundles) {
    const res = await pipeline.processSession(bundle);
    const expected = gtById.get(bundle.sessionId);
    const created = res.leads.filter((l) => l.bitrixLeadId != null).length;
    totalLeadsCreated += created;

    let mark = ' ';
    if (expected) {
      sessionsScored++;
      if (created === expected.expectedLeadCount) {
        leadCountCorrect++;
        mark = '✓';
      } else {
        mark = '✗';
      }
    }
    const label = expected?.name ?? bundle.sessionId;
    console.log(
      `${mark} ${label.padEnd(34)} status=${res.status.padEnd(7)} leads=${created}` +
        (expected ? ` (expected ${expected.expectedLeadCount})` : ''),
    );
    for (const l of res.leads) {
      if (l.warnings.length) console.log(`    ⚠ ${l.title}: ${l.warnings.join('; ')}`);
    }
  }

  console.log(`\n=== Metrics (self-consistency, PRD S14 caveat) ===`);
  console.log(`Lead-count accuracy : ${leadCountCorrect}/${sessionsScored} sessions`);
  console.log(`Total leads created : ${totalLeadsCreated}`);
  console.log(`Bitrix batch calls  : ${bitrix.batchCallCount}`);
  console.log(`Replies posted      : ${graph.postedReplies.length}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
