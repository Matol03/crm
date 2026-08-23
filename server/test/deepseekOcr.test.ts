import { describe, it, expect } from 'vitest';
import { DeepSeekOcrClient } from '../src/ocr/deepseek.js';
import type { VisionTransport } from '../src/ocr/deepseek.js';

describe('DeepSeekOcrClient', () => {
  it('short-circuits on pre-supplied fixture text (no vision call)', async () => {
    let called = false;
    const transport: VisionTransport = async () => {
      called = true;
      return 'should not run';
    };
    const c = new DeepSeekOcrClient({ apiKey: 'k', transport });
    const text = await c.readCard({ ocrText: 'Name: Anna' });
    expect(text).toBe('Name: Anna');
    expect(called).toBe(false);
  });

  it('calls the vision transport with image bytes and returns trimmed text', async () => {
    const transport: VisionTransport = async (bytes, mime) => {
      expect(bytes.length).toBeGreaterThan(0);
      expect(mime).toBe('image/png');
      return '  Name: Bob\nCompany: Acme  ';
    };
    const c = new DeepSeekOcrClient({ apiKey: 'k', transport });
    const text = await c.readCard({ bytes: new Uint8Array([1, 2, 3]) });
    expect(text).toBe('Name: Bob\nCompany: Acme');
  });

  it('returns null when there are no bytes and no text', async () => {
    const c = new DeepSeekOcrClient({ apiKey: 'k', transport: async () => 'x' });
    expect(await c.readCard({})).toBeNull();
  });

  it('fetches bytes from mediaUrl when a fetchBytes hook is provided', async () => {
    const c = new DeepSeekOcrClient({
      apiKey: 'k',
      transport: async () => 'Name: Fetched',
      fetchBytes: async () => ({ bytes: new Uint8Array([9]), mimeType: 'image/jpeg' }),
    });
    expect(await c.readCard({ mediaUrl: 'https://mock/card.png' })).toBe('Name: Fetched');
  });
});
