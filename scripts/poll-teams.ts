/**
 * Live Teams ingestion run (PRD Section 4): poll the configured channel, buffer
 * per author, and drive each closed session through the pipeline.
 *
 * One-shot by default (polls once, force-closes buffers, processes). Pass
 * --watch to poll continuously on POLL_INTERVAL_MS.
 *
 * Respects BITRIX_MODE: stays on mock Bitrix unless explicitly set to live.
 *
 * Usage:
 *   tsx scripts/poll-teams.ts            # one-shot, mock Bitrix
 *   tsx scripts/poll-teams.ts --watch    # continuous
 *   BITRIX_MODE=live tsx scripts/poll-teams.ts   # writes REAL leads
 */

import { loadConfig, redactedSummary } from '../server/src/config/index.js';
import { buildApp } from '../server/src/app.js';
import { IdleBuffer } from '../server/src/ingestion/buffer.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const watch = process.argv.includes('--watch');
  console.log('Config:', JSON.stringify(redactedSummary(cfg)));
  if (cfg.msgraphMode !== 'live') throw new Error('set MSGRAPH_MODE=live to poll the real channel');
  console.log(`Bitrix mode: ${cfg.bitrixMode.toUpperCase()}${cfg.bitrixMode === 'live' ? ' (WRITES REAL LEADS)' : ' (no CRM writes)'}`);

  const { graph, pipeline, bitrix, db } = buildApp(cfg, cfg.dbPath);
  const buffer = new IdleBuffer({
    idleTimeoutMs: cfg.idleTimeoutMs,
    maxSessionDurationMs: cfg.maxSessionDurationMs,
  });

  // Watermark: only messages newer than this are ingested. Persisted so a
  // restart resumes rather than re-reading the whole channel (message-level
  // idempotency makes any overlap harmless regardless).
  let since = db.getCampaign('graph_watermark') ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  console.log(`Polling since ${since}\n`);

  const pollOnce = async (forceClose: boolean): Promise<void> => {
    const messages = await graph.getNewChannelMessages(since);
    if (messages.length) {
      console.log(`[poll] ${messages.length} new message(s)`);
      for (const m of messages) {
        const preview = m.items.map((i) => i.type).join(',');
        console.log(`  ${m.timestamp} ${m.author.displayName} [${preview}]`);
        buffer.add(m);
        if (new Date(m.timestamp).getTime() > new Date(since).getTime()) since = m.timestamp;
      }
      db.setCampaign('graph_watermark', since);
    }

    const bundles = forceClose ? buffer.flushAll() : buffer.drainClosed(Date.now());
    for (const bundle of bundles) {
      console.log(`\n[session] ${bundle.author.email} — ${bundle.items.length} item(s)`);
      const res = await pipeline.processSession(bundle);
      console.log(`  status=${res.status} leads=${res.leads.length}`);
      if (res.error) console.log(`  error: ${res.error}`);
      for (const l of res.leads) {
        console.log(`  • ${l.title} -> ${l.bitrixLeadId != null ? bitrix.leadUrl(l.bitrixLeadId) : 'not written'}`);
        if (l.warnings.length) console.log(`    warnings: ${l.warnings.join('; ')}`);
      }
      if (res.replyText) console.log(`  reply: ${res.replyText}`);
    }
  };

  if (!watch) {
    // One-shot: force-close buffers so we don't wait out the idle timer.
    await pollOnce(true);
    console.log('\n[done] one-shot poll complete');
    return;
  }

  console.log(`[watch] polling every ${cfg.pollIntervalMs}ms — Ctrl+C to stop`);
  for (;;) {
    await pollOnce(false).catch((e) => console.error('[poll error]', e instanceof Error ? e.message : e));
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

main().catch((e) => {
  console.error('POLL FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
