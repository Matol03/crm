/**
 * Mock application wiring — assembles the pipeline from mock adapters so both
 * the batch runner (scripts/run-fixture-batch.ts) and tests share one factory.
 * Real adapters will be swapped in here per-mode once credentials are wired.
 */

import { Db } from './db/index.js';
import { Pipeline, type PipelineDeps } from './pipeline/index.js';
import { MockMsGraphClient } from './msgraph/mock.js';
import { MockAsrClient } from './asr/mock.js';
import { FixtureOcrClient } from './ocr/mock.js';
import { HeuristicLlmClient } from './llm/mock.js';
import { MockBitrixClient } from './bitrix/mock.js';
import type { AppConfig } from './config/index.js';

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
    config: {
      confidenceThreshold: cfg.confidenceThreshold,
      bitrixDefaultOwnerId: cfg.bitrixDefaultOwnerId,
      campaignExhibition: cfg.campaignExhibition,
      campaignSource: cfg.campaignSource,
    },
  };

  return { db, graph, bitrix, pipeline: new Pipeline(deps) };
}
