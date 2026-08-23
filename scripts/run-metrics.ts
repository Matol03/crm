/**
 * Section-15 metrics run: execute the whole synthetic set through the mock
 * pipeline, then score the created leads (read back from the DB) against
 * ground truth. Prints the accuracy table + latency percentiles.
 *
 * Caveat (S14): self-authored fixtures — a self-consistency check on pipeline
 * mechanics, not independent extraction validation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config/index.js';
import { buildMockApp } from '../server/src/app.js';
import { scoreBatch, type GroundTruth, type ScoredLead } from '../server/src/metrics/score.js';
import type { SessionBundle } from '../server/src/contracts/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCEN_DIR = resolve(ROOT, 'fixtures/scenarios');
const GT_PATH = resolve(ROOT, 'fixtures/ground-truth.json');

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { pipeline, db } = buildMockApp(cfg);

  const bundles = readdirSync(SCEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(SCEN_DIR, f), 'utf8')) as SessionBundle);
  const gt = JSON.parse(readFileSync(GT_PATH, 'utf8')) as GroundTruth;

  const perLeadLatency: number[] = [];
  for (const bundle of bundles) {
    const t0 = performance.now();
    const res = await pipeline.processSession(bundle);
    const elapsed = performance.now() - t0;
    const n = Math.max(1, res.leads.filter((l) => l.bitrixLeadId != null).length);
    for (let i = 0; i < n; i++) perLeadLatency.push(elapsed / n);
  }

  // Read created leads back from the DB for scoring.
  const created: ScoredLead[] = db
    .listLeads()
    .filter((r) => r.bitrix_lead_id != null && r.status === 'done')
    .map((r) => {
      const fields = r.fields_json ? JSON.parse(r.fields_json) : {};
      const g = fields.gated ?? {};
      return {
        sessionId: r.session_id,
        name: g.name ?? null,
        company: g.company ?? null,
        emails: Array.isArray(g.emails) ? g.emails.map((e: { value: string }) => e.value) : [],
        phones: Array.isArray(g.phones) ? g.phones.map((p: { value: string }) => p.value) : [],
        leadType: g.leadType === 'partner' ? 'partner' : 'customer',
      } satisfies ScoredLead;
    });

  const report = scoreBatch(gt, created);
  const sorted = [...perLeadLatency].sort((a, b) => a - b);

  console.log('\n=== Section-15 metrics (synthetic, self-consistency — S14 caveat) ===\n');
  console.log(`Lead-count accuracy   : ${report.leadCount.correct}/${report.leadCount.total} exact, ${report.leadCount.withinTolerance}/${report.leadCount.total} within ±1`);
  console.log(`Field precision       : ${(report.fieldPrecision.precision * 100).toFixed(1)}% (${report.fieldPrecision.correct}/${report.fieldPrecision.populated} populated fields)`);
  console.log(`Cross-contamination   : ${(report.crossContamination.rate * 100).toFixed(1)}% (${report.crossContamination.contaminated}/${report.crossContamination.total} leads)  <-- headline`);
  console.log(`Partner precision     : ${(report.partner.precision * 100).toFixed(1)}%  recall: ${(report.partner.recall * 100).toFixed(1)}%  (tp=${report.partner.tp} fp=${report.partner.fp} fn=${report.partner.fn})`);
  console.log(`Non-lead FP / FN      : ${report.nonLead.falsePositives} / ${report.nonLead.falseNegatives}`);
  console.log(`Total leads created   : ${report.totalCreated}`);
  console.log(`Latency per lead (mock, no network): p50=${pct(sorted, 50).toFixed(2)}ms  p95=${pct(sorted, 95).toFixed(2)}ms`);
  console.log('\nNote: mock-mode latency reflects pipeline overhead only; real LLM/Bitrix\nlatency is dominated by network + model time (measure live separately).\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
