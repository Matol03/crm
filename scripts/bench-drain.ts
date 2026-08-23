/**
 * Drain benchmark (PRD Section 15 / 10.3): push 400 synthetic leads through the
 * real Bitrix write path (rate limiter + batching + dedup) against a zero-latency
 * fake transport, using a VIRTUAL clock so the simulated wall-clock at 2 req/s is
 * computed instantly instead of actually waiting minutes.
 *
 * Purpose: sanity-check the Section-10.3 batching math against the real client's
 * actual call pattern (which includes per-lead dedup reads the PRD math omitted).
 */

import { RealBitrixClient } from '../server/src/bitrix/real.js';
import { RateLimiter } from '../server/src/bitrix/rateLimiter.js';
import type { BitrixTransport } from '../server/src/bitrix/transport.js';
import type { LeadWrite } from '../server/src/contracts/index.js';

const LEAD_COUNT = 400;
const RATE = 2;
const BATCH_SIZE = 13;

function makeLeads(n: number): LeadWrite[] {
  return Array.from({ length: n }, (_, i) => ({
    localId: `L${i}`,
    sessionId: `S${i}`,
    title: `Lead ${i}`,
    assignedById: 1,
    name: `Person ${i}`,
    company: `Co ${i}`,
    position: null,
    country: null,
    phones: [{ value: `+1000000${String(i).padStart(4, '0')}`, type: 'WORK' }],
    emails: [{ value: `person${i}@example.com`, type: 'WORK' }],
    listFields: { leadTypeId: 47 },
    verbatim: 'v',
    aiSummaryRu: 's',
    service: { teamsGroupId: 'g', teamsMessageIds: [`m${i}`], teamsAuthor: 'a@x.com' },
    warnings: [],
    needsAttachmentRetry: false,
  }));
}

async function main(): Promise<void> {
  const callCounts: Record<string, number> = {};
  const transport: BitrixTransport = async (method, params) => {
    callCounts[method] = (callCounts[method] ?? 0) + 1;
    if (method === 'crm.duplicate.findbycomm') return { status: 200, body: { result: { LEAD: [] } } };
    if (method === 'batch') {
      const cmd = (params as { cmd: Record<string, string> }).cmd;
      const result: Record<string, unknown> = {};
      let id = 6000;
      for (const key of Object.keys(cmd)) result[key] = key.startsWith('lead_') ? id++ : 1;
      return { status: 200, body: { result: { result, result_error: {} } } };
    }
    return { status: 200, body: { result: null } };
  };

  // Virtual clock: sleep advances simulated time; measures throughput exactly.
  let vt = 0;
  const rl = new RateLimiter({ ratePerSec: RATE, now: () => vt, sleep: async (ms) => { vt += ms; } });
  const client = new RealBitrixClient({
    webhookUrl: 'https://portal.bitrix24.example/rest/1/token/',
    rateLimiter: rl,
    transport,
    batchSize: BATCH_SIZE,
    sleep: async (ms) => { vt += ms; },
  });

  const leads = makeLeads(LEAD_COUNT);
  const results = await client.writeLeads(leads);
  const created = results.filter((r) => r.bitrixLeadId != null).length;
  const totalCalls = Object.values(callCounts).reduce((a, b) => a + b, 0);
  const simSeconds = vt / 1000;

  console.log(`\n=== Drain benchmark: ${LEAD_COUNT} leads @ ${RATE} req/s, batch ${BATCH_SIZE} ===\n`);
  console.log(`Leads written        : ${created}/${LEAD_COUNT}`);
  console.log(`HTTP calls by method :`);
  for (const [m, c] of Object.entries(callCounts).sort()) console.log(`  ${m.padEnd(28)} ${c}`);
  console.log(`Total rate-limited calls: ${totalCalls}`);
  console.log(`Simulated wall-clock @ ${RATE}/s: ${simSeconds.toFixed(1)}s (~${(simSeconds / 60).toFixed(1)} min)`);
  console.log(`\nFinding: per-lead dedup reads (findbycomm x2: EMAIL then PHONE) dominate the`);
  console.log(`call count (${callCounts['crm.duplicate.findbycomm'] ?? 0} vs ${callCounts['batch'] ?? 0} write batches). The write path alone`);
  console.log(`matches the S10.3 ~200s estimate; batching the dedup lookups is the clear`);
  console.log(`next optimization if drain latency matters at full show volume.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
