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
import { RealMsGraphClient } from './msgraph/real.js';
import { MockAsrClient } from './asr/mock.js';
import { FixtureOcrClient } from './ocr/mock.js';
import { DeepSeekOcrClient } from './ocr/deepseek.js';
import { GeminiOcrClient } from './ocr/gemini.js';
import { HeuristicLlmClient } from './llm/mock.js';
import { DeepSeekLlmClient } from './llm/deepseek.js';
import { GeminiLlmClient } from './llm/gemini.js';
import { MockBitrixClient } from './bitrix/mock.js';
import { RealBitrixClient } from './bitrix/real.js';
import { PlatformLeadStore } from './platform/store.js';
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

  const graph: MsGraphClient =
    cfg.msgraphMode === 'live'
      ? new RealMsGraphClient({
          tenantId: cfg.graph.tenantId,
          clientId: cfg.graph.clientId,
          clientSecret: cfg.graph.clientSecret,
          teamsGroupId: cfg.graph.teamsGroupId,
          channelId: cfg.graph.channelId,
          // Structured, PII-free degradation notices (S13).
          onWarn: (e) => console.warn(JSON.stringify({ level: 'warn', src: 'msgraph', ...e })),
        })
      : new MockMsGraphClient();

  const asr: AsrClient = new MockAsrClient();

  let ocr: OcrClient;
  if (cfg.ocrMode === 'live') {
    ocr =
      cfg.ocrProvider === 'gemini'
        ? new GeminiOcrClient({ apiKey: cfg.geminiApiKey, baseUrl: cfg.geminiBaseUrl, model: cfg.geminiModel })
        : new DeepSeekOcrClient({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl, model: cfg.deepseekVisionModel });
  } else {
    ocr = new FixtureOcrClient();
  }

  let llm: LlmClient;
  if (cfg.llmMode === 'live') {
    llm =
      cfg.llmProvider === 'gemini'
        ? new GeminiLlmClient({ apiKey: cfg.geminiApiKey, baseUrl: cfg.geminiBaseUrl, model: cfg.geminiModel })
        : new DeepSeekLlmClient({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl, model: cfg.deepseekModel });
  } else {
    llm = new HeuristicLlmClient();
  }

  // Lead sink. Default 'platform': leads are stored by this service and shown
  // on the dashboard. 'bitrix' restores the portal write path unchanged.
  const bitrix: BitrixClient =
    cfg.leadSink === 'platform'
      ? new PlatformLeadStore({ db, initialStatusId: cfg.bitrixInitialStatusId })
      : cfg.bitrixMode === 'live'
      ? new RealBitrixClient({
          webhookUrl: cfg.bitrixWebhookUrl,
          rateLimiter: new RateLimiter({ ratePerSec: cfg.bitrixRateLimitPerSec }),
          transport: createHttpTransport(cfg.bitrixWebhookUrl),
          batchSize: cfg.bitrixBatchSize,
          initialStatusId: cfg.bitrixInitialStatusId,
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
