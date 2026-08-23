/**
 * Live end-to-end demo: runs selected fixtures through the REAL configured LLM
 * (Gemini) for segmentation + extraction, writing to MOCK Bitrix (no live CRM).
 * Proves the pipeline works with a live model. Makes real Gemini calls.
 *
 * Usage: tsx scripts/live-demo.ts [fixture-name ...]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, redactedSummary } from '../server/src/config/index.js';
import { buildApp } from '../server/src/app.js';
import type { SessionBundle } from '../server/src/contracts/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCEN_DIR = resolve(ROOT, 'fixtures/scenarios');

const DEFAULT = ['card-first-then-voice-name-mismatch', 'partner-reseller', 'three-contacts-back-to-back'];

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log('Config:', JSON.stringify(redactedSummary(cfg)));
  if (cfg.bitrixMode !== 'mock') throw new Error('refusing to run: BITRIX_MODE must be mock for this demo');

  const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  const { pipeline, bitrix } = buildApp(cfg, ':memory:');

  for (const name of names) {
    const bundle = JSON.parse(readFileSync(resolve(SCEN_DIR, `${name}.json`), 'utf8')) as SessionBundle;
    console.log(`\n=== ${name} (${bundle.items.length} messages) ===`);
    const t0 = performance.now();
    const res = await pipeline.processSession(bundle);
    const ms = Math.round(performance.now() - t0);
    console.log(`status=${res.status} leads=${res.leads.length} in ${ms}ms`);
    if (res.error) console.log(`error: ${res.error}`);
    console.log(`reply: ${res.replyText ?? '(none)'}`);
    for (const l of res.leads) console.log(`  • ${l.title}${l.warnings.length ? '  [' + l.warnings.join('; ') + ']' : ''}`);
  }

  console.log(`\nMock Bitrix leads written: ${(bitrix as { allLeads?: () => unknown[] }).allLeads?.().length ?? '?'}`);
}

main().catch((e) => {
  console.error('LIVE DEMO FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
