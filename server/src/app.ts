/**
 * Application wiring — assembles the pipeline, choosing real vs mock adapters
 * per-mode from config. `buildMockApp` forces all-mock (used by the batch runner
 * and tests); `buildApp` honors the env mode flags.
 *
 * Real adapters are constructed only when their mode is `live`/`gemini`, so a
 * fully-mock run needs no credentials at all.
 */

import { Db } from './db/index.js';
import { Pipeline, type PipelineDeps } from './pipeline/index.js';
import { MockMsGraphClient } from './msgraph/mock.js';
import { MockAsrClient } from './asr/mock.js';
import { FixtureOcrClient } from './ocr/mock.js';
import { DeepSeekOcrClient } from './ocr/deepseek.js';
import { HeuristicLlmClient } from './llm/mock.js';
import { DeepSeekLlmClient } from './llm/deepseek.js';
import { MockBitrixClient } from './bitrix/mock.js';
import { RealBitrixClient } from './bitrix/real.js';
import { RateLimiter } from './bitrix/rateLimiter.js';
import { createHttpTransport } from './bitrix/transport.js';
import type { AsrClient, OcrClient, LlmClient, BitrixClient, MsGraphClient } from './contracts/index.js';
import type { AppConfig } from './config/index.js';

export interface App {
  db: Db;
  graph: MsGraphClient;
  bitrix: BitrixClient;
  pipeline: Pipeline;
}

function pipelineConfig(cfg: AppConfig): PipelineDeps['config'] {
  return {
    confidenceThreshold: cfg.confidenceThreshold,
    bitrixDefaultOwnerId: cfg.bitrixDefaultOwnerId,
    campaignExhibition: cfg.campaignExhibition,
    campaignSource: cfg.campaignSource,
  };
}

/** Honor env mode flags; construct real clients only where live. */
export function buildApp(cfg: AppConfig, dbPath = cfg.dbPath): App {
  const db = new Db(dbPath);

  // Graph: real ingestion is deferred (Q2) — mock stands in for both modes.
  const graph: MsGraphClient = new MockMsGraphClient();

  const asr: AsrClient = new MockAsrClient();

  const ocr: OcrClient =
    cfg.ocrMode === 'deepseek'
      ? new DeepSeekOcrClient({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl, model: cfg.deepseekVisionModel })
      : new FixtureOcrClient();

  const llm: LlmClient =
    cfg.llmMode === 'live'
      ? new DeepSeekLlmClient({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl, model: cfg.deepseekModel })
      : new HeuristicLlmClient();

  const bitrix: BitrixClient =
    cfg.bitrixMode === 'live'
      ? new RealBitrixClient({
          webhookUrl: cfg.bitrixWebhookUrl,
          rateLimiter: new RateLimiter({ ratePerSec: cfg.bitrixRateLimitPerSec }),
          transport: createHttpTransport(cfg.bitrixWebhookUrl),
          batchSize: cfg.bitrixBatchSize,
        })
      : new MockBitrixClient();

  const deps: PipelineDeps = { db, graph, asr, ocr, llm, bitrix, config: pipelineConfig(cfg) };
  return { db, graph, bitrix, pipeline: new Pipeline(deps) };
}

// ── all-mock wiring (tests + fixture batch) ──────────────────

export interface MockApp {
  db: Db;
  graph: MockMsGraphClient;
  bitrix: MockBitrixClient;
  pipeline: Pipeline;
}

export function buildMockApp(cfg: AppConfig, dbPath = ':memory:'): MockApp {
  const db = new Db(dbPath);
  const graph = new MockMsGraphClient();
  const bitrix = new MockBitrixClient();
  const deps: PipelineDeps = {
    db,
    graph,
    asr: new MockAsrClient(),
    ocr: new FixtureOcrClient(),
    llm: new HeuristicLlmClient(),
    bitrix,
    config: pipelineConfig(cfg),
  };
  return { db, graph, bitrix, pipeline: new Pipeline(deps) };
}
