/**
 * Read-only live smoke test for the DeepSeek vision OCR path.
 * Usage: tsx scripts/smoke-ocr.ts <path-to-card-image>
 * Reads the image, sends it to the configured DeepSeek vision model, prints the
 * transcribed card text. Makes ONE live DeepSeek call; no writes anywhere.
 */

import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/src/config/index.js';
import { GeminiOcrClient } from '../server/src/ocr/gemini.js';
import { DeepSeekOcrClient } from '../server/src/ocr/deepseek.js';
import type { OcrClient } from '../server/src/contracts/index.js';

async function main(): Promise<void> {
  const imgPath = process.argv[2];
  if (!imgPath) throw new Error('usage: tsx scripts/smoke-ocr.ts <image>');
  const cfg = loadConfig();
  const bytes = new Uint8Array(readFileSync(imgPath));
  const mimeType = imgPath.endsWith('.jpg') || imgPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

  let ocr: OcrClient;
  let modelLabel: string;
  if (cfg.ocrProvider === 'deepseek') {
    ocr = new DeepSeekOcrClient({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl, model: cfg.deepseekVisionModel });
    modelLabel = cfg.deepseekVisionModel;
  } else {
    ocr = new GeminiOcrClient({ apiKey: cfg.geminiApiKey, baseUrl: cfg.geminiBaseUrl, model: cfg.geminiModel });
    modelLabel = cfg.geminiModel;
  }

  console.log(`Sending ${bytes.length} bytes (${mimeType}) to ${modelLabel} ...\n`);
  const t0 = performance.now();
  const text = await ocr.readCard({ bytes, mimeType });
  const ms = Math.round(performance.now() - t0);
  console.log('--- transcribed card text ---');
  console.log(text ?? '(null)');
  console.log(`\n[ok in ${ms}ms]`);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
