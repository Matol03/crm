import { describe, it, expect } from 'vitest';
import { GeminiOcrClient } from '../src/ocr/gemini.js';
import type { VisionTransport } from '../src/ocr/gemini.js';

describe('GeminiOcrClient', () => {
  it('short-circuits on pre-supplied fixture text (no vision call)', async () => {
    let called = false;
    const transport: VisionTransport = async () => {
      called = true;
      return 'nope';
    };
    const c = new GeminiOcrClient({ apiKey: 'k', transport });
    expect(await c.readCard({ ocrText: 'Name: Anna' })).toBe('Name: Anna');
    expect(called).toBe(false);
  });

  it('calls the vision transport with bytes and trims the result', async () => {
    const transport: VisionTransport = async (bytes, mime) => {
      expect(bytes.length).toBeGreaterThan(0);
      expect(mime).toBe('image/png');
      return '  Name: Bob  ';
    };
    const c = new GeminiOcrClient({ apiKey: 'k', transport });
    expect(await c.readCard({ bytes: new Uint8Array([1, 2, 3]) })).toBe('Name: Bob');
  });

  it('returns null with neither bytes nor text', async () => {
    const c = new GeminiOcrClient({ apiKey: 'k', transport: async () => 'x' });
    expect(await c.readCard({})).toBeNull();
  });
});
