import { describe, it, expect } from 'vitest';
import { parseEnvFile, loadConfig, validateConfig, redactedSummary } from '../src/config/index.js';

describe('config: parseEnvFile', () => {
  it('parses keys, strips comments and quotes', () => {
    const env = parseEnvFile(
      ['# comment', 'A=1', 'B = two words', 'C="quoted"', "D='single'", 'E=val # inline', '', 'BAD_LINE'].join('\n'),
    );
    expect(env.A).toBe('1');
    expect(env.B).toBe('two words');
    expect(env.C).toBe('quoted');
    expect(env.D).toBe('single');
    expect(env.E).toBe('val');
    expect('BAD_LINE' in env).toBe(false);
  });
});

describe('config: loadConfig + validation', () => {
  const base = { BITRIX_MODE: 'mock', LLM_MODE: 'mock', MSGRAPH_MODE: 'mock' };

  it('applies defaults and coerces numbers', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.idleTimeoutMs).toBe(240000);
    expect(cfg.confidenceThreshold).toBe(0.6);
    expect(cfg.bitrixBatchSize).toBe(13);
  });

  it('throws when a live mode lacks its credential', () => {
    expect(() => loadConfig({ ...base, BITRIX_MODE: 'live', BITRIX_WEBHOOK_URL: '' })).toThrow(/BITRIX_WEBHOOK_URL/);
    expect(() => loadConfig({ ...base, LLM_MODE: 'live', DEEPSEEK_API_KEY: '' })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('rejects out-of-range confidence threshold', () => {
    expect(() => validateConfig({ ...loadConfig(base), confidenceThreshold: 2 } as never)).toThrow(/CONFIDENCE_THRESHOLD/);
  });

  it('redactedSummary never leaks secrets', () => {
    const cfg = loadConfig({ ...base, BITRIX_WEBHOOK_URL: 'https://secret/webhook/', DEEPSEEK_API_KEY: 'sk-secret' });
    const summary = JSON.stringify(redactedSummary(cfg));
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('sk-');
    expect(summary).toContain('deepseekKeyConfigured');
  });
});
