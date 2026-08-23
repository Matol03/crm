/**
 * Environment loading + validation (PRD Section 13: secrets only from env).
 *
 * Loads `.env` (minimal parser, no dependency), validates required values for
 * the active mode, and exposes a typed, frozen config. Secrets are held here
 * and never logged — see `redactedSummary()` for what is safe to print.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Mode = 'mock' | 'live';
export type OcrMode = 'fixture' | 'live' | 'none';
export type LlmProvider = 'gemini' | 'deepseek';
export type OcrProvider = 'gemini' | 'deepseek';

export interface AppConfig {
  bitrixMode: Mode;
  msgraphMode: Mode;
  llmMode: Mode;
  asrMode: Mode;
  ocrMode: OcrMode;
  llmProvider: LlmProvider;
  ocrProvider: OcrProvider;

  bitrixWebhookUrl: string;
  bitrixDefaultOwnerId: number;
  /** STATUS_ID applied to newly created leads (never on update). */
  bitrixInitialStatusId: string;

  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekVisionModel: string;

  geminiApiKey: string;
  geminiBaseUrl: string;
  geminiModel: string;

  graph: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    teamsGroupId: string;
    channelId: string;
  };

  asrProvider: string;
  asrApiKey: string;

  idleTimeoutMs: number;
  maxSessionDurationMs: number;
  pollIntervalMs: number;
  confidenceThreshold: number;
  bitrixRateLimitPerSec: number;
  bitrixBatchSize: number;

  campaignExhibition: string;
  campaignSource: string;

  dbPath: string;
  apiPort: number;
  apiSharedSecret: string;
}

/** Parse a `.env` file into a flat object. Ignores comments/blank lines. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip an inline comment that is preceded by whitespace (not inside a value).
    const hash = value.indexOf(' #');
    if (hash !== -1) value = value.slice(0, hash).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mode(v: string | undefined, fallback: Mode = 'mock'): Mode {
  return v === 'live' ? 'live' : v === 'mock' ? 'mock' : fallback;
}

/**
 * Build config from a raw env map (defaults to process.env merged with .env).
 * Passing an explicit map keeps this pure and testable.
 */
export function loadConfig(raw?: Record<string, string | undefined>): AppConfig {
  let env: Record<string, string | undefined>;
  if (raw) {
    env = raw;
  } else {
    let fileEnv: Record<string, string> = {};
    try {
      fileEnv = parseEnvFile(readFileSync(resolve(process.cwd(), '.env'), 'utf8'));
    } catch {
      // No .env file — rely on process.env (e.g. CI, mock tests).
    }
    env = { ...fileEnv, ...process.env };
  }

  const cfg: AppConfig = {
    bitrixMode: mode(env.BITRIX_MODE),
    msgraphMode: mode(env.MSGRAPH_MODE),
    llmMode: mode(env.LLM_MODE),
    asrMode: mode(env.ASR_MODE),
    ocrMode: (env.OCR_MODE as OcrMode) || 'fixture',
    llmProvider: env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'gemini',
    ocrProvider: env.OCR_PROVIDER === 'deepseek' ? 'deepseek' : 'gemini',

    bitrixWebhookUrl: env.BITRIX_WEBHOOK_URL ?? '',
    bitrixDefaultOwnerId: num(env.BITRIX_DEFAULT_OWNER_ID, 1),
    bitrixInitialStatusId: env.BITRIX_INITIAL_STATUS_ID ?? 'NEW',

    deepseekApiKey: env.DEEPSEEK_API_KEY ?? '',
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    deepseekModel: env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    deepseekVisionModel: env.DEEPSEEK_VISION_MODEL ?? 'deepseek-v4-flash-vision-exp',

    geminiApiKey: env.GEMINI_API_KEY ?? '',
    geminiBaseUrl: env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com',
    geminiModel: env.GEMINI_MODEL ?? 'gemini-2.5-flash',

    graph: {
      tenantId: env.GRAPH_TENANT_ID ?? '',
      clientId: env.GRAPH_CLIENT_ID ?? '',
      clientSecret: env.GRAPH_CLIENT_SECRET ?? '',
      teamsGroupId: env.GRAPH_TEAMS_GROUP_ID ?? '',
      channelId: env.GRAPH_CHANNEL_ID ?? '',
    },

    asrProvider: env.ASR_PROVIDER ?? '',
    asrApiKey: env.ASR_API_KEY ?? '',

    idleTimeoutMs: num(env.IDLE_TIMEOUT_MS, 240000),
    maxSessionDurationMs: num(env.MAX_SESSION_DURATION_MS, 900000),
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 20000),
    confidenceThreshold: num(env.CONFIDENCE_THRESHOLD, 0.6),
    bitrixRateLimitPerSec: num(env.BITRIX_RATE_LIMIT_PER_SEC, 2),
    bitrixBatchSize: num(env.BITRIX_BATCH_SIZE, 13),

    campaignExhibition: env.CAMPAIGN_EXHIBITION ?? '',
    campaignSource: env.CAMPAIGN_SOURCE ?? '',

    dbPath: env.DB_PATH ?? './data/lead-service.sqlite',
    apiPort: num(env.API_PORT, 4318),
    apiSharedSecret: env.API_SHARED_SECRET ?? '',
  };

  validateConfig(cfg);
  return Object.freeze(cfg);
}

/** Throw if a live mode is selected without the credentials it needs. */
export function validateConfig(cfg: AppConfig): void {
  const errors: string[] = [];
  if (cfg.bitrixMode === 'live' && !cfg.bitrixWebhookUrl) {
    errors.push('BITRIX_MODE=live requires BITRIX_WEBHOOK_URL');
  }
  if (cfg.llmMode === 'live') {
    if (cfg.llmProvider === 'gemini' && !cfg.geminiApiKey) errors.push('LLM_MODE=live with LLM_PROVIDER=gemini requires GEMINI_API_KEY');
    if (cfg.llmProvider === 'deepseek' && !cfg.deepseekApiKey) errors.push('LLM_MODE=live with LLM_PROVIDER=deepseek requires DEEPSEEK_API_KEY');
  }
  if (cfg.msgraphMode === 'live') {
    if (!cfg.graph.tenantId || !cfg.graph.clientId || !cfg.graph.clientSecret) {
      errors.push('MSGRAPH_MODE=live requires GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET');
    }
  }
  if (cfg.ocrMode === 'live') {
    if (cfg.ocrProvider === 'gemini' && !cfg.geminiApiKey) errors.push('OCR_MODE=live with OCR_PROVIDER=gemini requires GEMINI_API_KEY');
    if (cfg.ocrProvider === 'deepseek' && !cfg.deepseekApiKey) errors.push('OCR_MODE=live with OCR_PROVIDER=deepseek requires DEEPSEEK_API_KEY');
  }
  if (cfg.confidenceThreshold < 0 || cfg.confidenceThreshold > 1) {
    errors.push('CONFIDENCE_THRESHOLD must be between 0 and 1');
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

/** Safe-to-log view: modes and non-secret tuning only, never secrets/URLs. */
export function redactedSummary(cfg: AppConfig): Record<string, unknown> {
  return {
    bitrixMode: cfg.bitrixMode,
    msgraphMode: cfg.msgraphMode,
    llmMode: cfg.llmMode,
    asrMode: cfg.asrMode,
    ocrMode: cfg.ocrMode,
    llmProvider: cfg.llmProvider,
    ocrProvider: cfg.ocrProvider,
    bitrixWebhookConfigured: cfg.bitrixWebhookUrl.length > 0,
    deepseekKeyConfigured: cfg.deepseekApiKey.length > 0,
    geminiKeyConfigured: cfg.geminiApiKey.length > 0,
    idleTimeoutMs: cfg.idleTimeoutMs,
    maxSessionDurationMs: cfg.maxSessionDurationMs,
    pollIntervalMs: cfg.pollIntervalMs,
    confidenceThreshold: cfg.confidenceThreshold,
    bitrixRateLimitPerSec: cfg.bitrixRateLimitPerSec,
    bitrixBatchSize: cfg.bitrixBatchSize,
    campaignExhibition: cfg.campaignExhibition,
    campaignSource: cfg.campaignSource,
  };
}
