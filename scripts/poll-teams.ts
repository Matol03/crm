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

  /** Set when a session fails because the model's quota is exhausted. */
  let quotaExhausted = false;

  // Watermark: only messages newer than this are ingested. Persisted so a
  // restart resumes rather than re-reading the whole channel (message-level
  // idempotency makes any overlap harmless regardless).
  let since = db.getCampaign('graph_watermark') ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  console.log(`Polling since ${since}\n`);

  const pollOnce = async (forceClose: boolean): Promise<void> => {
    const messages = await graph.getNewChannelMessages(since);
    // Highest timestamp seen this round — only committed once the messages it
    // covers have actually been handled (see below).
    let highWater = since;
    if (messages.length) {
      console.log(`[poll] ${messages.length} new message(s)`);
      for (const m of messages) {
        const preview = m.items.map((i) => i.type).join(',');
        console.log(`  ${m.timestamp} ${m.author.displayName} [${preview}]`);
        buffer.add(m);
        if (new Date(m.timestamp).getTime() > new Date(highWater).getTime()) highWater = m.timestamp;
      }
    }

    const bundles = forceClose ? buffer.flushAll() : buffer.drainClosed(Date.now());
    // A session that fails must NOT let the watermark move past its messages,
    // or they would never be polled again and the leads would be lost silently.
    // (The idempotency ledger only protects against duplicates, not omissions.)
    let earliestFailure: string | null = null;

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

      if (res.status === 'error' && /429|RESOURCE_EXHAUSTED|quota/i.test(res.error ?? '')) {
        quotaExhausted = true;
      }
      if (res.status === 'error') {
        const oldest = bundle.items.reduce(
          (min, i) => (new Date(i.timestamp).getTime() < new Date(min).getTime() ? i.timestamp : min),
          bundle.items[0]?.timestamp ?? highWater,
        );
        if (!earliestFailure || new Date(oldest).getTime() < new Date(earliestFailure).getTime()) {
          earliestFailure = oldest;
        }
      }
    }

    if (earliestFailure) {
      // Rewind to just before the earliest failed message so it is re-polled.
      const rewound = new Date(new Date(earliestFailure).getTime() - 1).toISOString();
      since = new Date(rewound).getTime() < new Date(since).getTime() ? rewound : since;
      console.log(`  [watermark] held at ${since} — failed messages will be retried`);
    } else {
      since = highWater;
    }
    db.setCampaign('graph_watermark', since);
  };

  if (!watch) {
    // One-shot: force-close buffers so we don't wait out the idle timer.
    await pollOnce(true);
    console.log('\n[done] one-shot poll complete');
    return;
  }

  console.log(`[watch] polling every ${cfg.pollIntervalMs}ms — Ctrl+C to stop`);
  // An exhausted DAILY model quota cannot be retried away, so hammering the
  // provider every poll wastes calls and floods the log. Back off hard when we
  // see it, and return to the normal cadence as soon as a poll succeeds.
  const QUOTA_BACKOFF_MS = 15 * 60_000;
  let quotaBackoff = false;

  for (;;) {
    quotaBackoff = false;
    await pollOnce(false).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) quotaBackoff = true;
      console.error('[poll error]', msg);
    });
    if (quotaExhausted) {
      quotaExhausted = false;
      console.log(`[quota] model quota exhausted — pausing ${QUOTA_BACKOFF_MS / 60000} min before the next poll.`);
      console.log('[quota] messages are NOT lost: the watermark is held and they are retried after the pause.');
      await new Promise((r) => setTimeout(r, QUOTA_BACKOFF_MS));
      continue;
    }
    await new Promise((r) => setTimeout(r, quotaBackoff ? QUOTA_BACKOFF_MS : cfg.pollIntervalMs));
  }
}

main().catch((e) => {
  console.error('POLL FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
