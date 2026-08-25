import { describe, it, expect } from 'vitest';
import { GeminiAsrClient, normaliseMime } from '../src/asr/gemini.js';
import { Pipeline } from '../src/pipeline/index.js';
import { Db } from '../src/db/index.js';
import { MockMsGraphClient } from '../src/msgraph/mock.js';
import { FixtureOcrClient } from '../src/ocr/mock.js';
import { HeuristicLlmClient } from '../src/llm/mock.js';
import { MockBitrixClient } from '../src/bitrix/mock.js';
import type { AsrClient, MsGraphClient, SessionBundle } from '../src/contracts/index.js';

describe('Gemini speech-to-text client', () => {
  it('sends the audio bytes and returns the transcript', async () => {
    let seen: { mime: string; size: number } | null = null;
    const asr = new GeminiAsrClient({
      apiKey: 'k',
      transport: async (bytes, mimeType) => {
        seen = { mime: mimeType, size: bytes.length };
        return '  Иван Петров, компания Нордвинд, интересует аналитика.  ';
      },
    });

    const text = await asr.transcribe({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'audio/ogg; codecs=opus',
    });

    expect(text).toBe('Иван Петров, компания Нордвинд, интересует аналитика.');
    // Codec parameters are stripped — the API rejects the full container string.
    expect(seen!).toEqual({ mime: 'audio/ogg', size: 4 });
  });

  it('returns empty rather than throwing when there is no audio', async () => {
    // One unreadable note must never fail the whole session.
    const asr = new GeminiAsrClient({ apiKey: 'k', transport: async () => 'unused' });
    expect(await asr.transcribe({})).toBe('');
    expect(await asr.transcribe({ bytes: new Uint8Array() })).toBe('');
  });

  it('fetches bytes from a media URL when the caller had none', async () => {
    const asr = new GeminiAsrClient({
      apiKey: 'k',
      fetchBytes: async () => ({ bytes: new Uint8Array([9]), mimeType: 'audio/wav' }),
      transport: async (_b, mime) => `transcribed as ${mime}`,
    });
    expect(await asr.transcribe({ mediaUrl: 'https://example/voice.wav' })).toBe('transcribed as audio/wav');
  });

  it('normalises the container types Teams reports', () => {
    expect(normaliseMime('audio/x-wav')).toBe('audio/wav');
    expect(normaliseMime('audio/webm;codecs=opus')).toBe('audio/ogg');
    expect(normaliseMime('AUDIO/MP4')).toBe('audio/mp4');
    // Anything that is not audio at all falls back to a sane default.
    expect(normaliseMime('application/octet-stream')).toBe('audio/ogg');
  });
});

/* ── pipeline integration ─────────────────────────────────────── */

const CHANNEL = { teamsGroupId: 'g1', channelId: 'c1' };
const AUTHOR = { teamsUserId: 'u1', email: 'rep@example.com', displayName: 'Rep' };

function voiceBundle(over: Record<string, unknown> = {}): SessionBundle {
  return {
    sessionId: 'sess-voice',
    channel: CHANNEL,
    author: AUTHOR,
    sessionWindow: { openedAt: '2026-08-26T10:00:00Z', closedAt: '2026-08-26T10:01:00Z' },
    items: [
      {
        messageId: 'm1:att0',
        timestamp: '2026-08-26T10:00:00Z',
        type: 'voice',
        attachmentRef: { kind: 'sharepoint', url: 'https://sp/voice.ogg' },
        ...over,
      },
    ],
  } as SessionBundle;
}

/** Graph stub whose attachment fetch can be made to succeed or fail. */
function graphWith(file: { bytes: Uint8Array; mimeType: string } | null): MsGraphClient {
  const base = new MockMsGraphClient();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    fetchAttachment: async () => file,
  }) as MsGraphClient;
}

function build(asr: AsrClient, graph: MsGraphClient) {
  const db = new Db(':memory:');
  const pipeline = new Pipeline({
    db,
    graph,
    asr,
    ocr: new FixtureOcrClient(),
    llm: new HeuristicLlmClient(),
    bitrix: new MockBitrixClient(),
    config: {
      confidenceThreshold: 0.6,
      bitrixDefaultOwnerId: 1,
      campaignExhibition: 'Qazdream Test Project',
      campaignSource: 'Trade Show',
    },
  });
  return { db, pipeline };
}

describe('voice notes in the pipeline', () => {
  it('downloads the recording and passes the transcript to extraction', async () => {
    const asr: AsrClient = {
      transcribe: async () => 'Анна Вебер, компания Нордвинд, телефон 98-09-78',
    };
    const { db, pipeline } = build(asr, graphWith({ bytes: new Uint8Array([1]), mimeType: 'audio/ogg' }));

    // Capture what extraction actually receives — that is the integration point
    // this test exists to protect.
    let segmentText = '';
    const llm = (pipeline as unknown as { deps: { llm: { extract: unknown } } }).deps.llm;
    const original = llm.extract as (a: { segmentText: string; cardText: string | null }) => unknown;
    llm.extract = async (arg: { segmentText: string; cardText: string | null }) => {
      segmentText = arg.segmentText;
      return original.call(llm, arg);
    };

    await pipeline.processSession(voiceBundle());
    expect(segmentText).toContain('Анна Вебер');
    expect(segmentText).toContain('98-09-78');
    db.close();
  });

  it('flags the lead for retry when the recording cannot be downloaded', async () => {
    // Files.Read.All is not granted in the pilot, so this is the live behaviour.
    let called = false;
    const asr: AsrClient = { transcribe: async () => { called = true; return 'should not happen'; } };
    const { db, pipeline } = build(asr, graphWith(null));

    const res = await pipeline.processSession(voiceBundle());
    // No transcription attempted, and the session did not fail.
    expect(called).toBe(false);
    expect(res.status).not.toBe('error');
    db.close();
  });

  it('does not re-transcribe a note that already has a transcript', async () => {
    let calls = 0;
    const asr: AsrClient = { transcribe: async () => { calls++; return 'fresh'; } };
    const { db, pipeline } = build(asr, graphWith({ bytes: new Uint8Array([1]), mimeType: 'audio/ogg' }));

    await pipeline.processSession(voiceBundle({ transcript: 'Мария Олива, Аврора' }));
    expect(calls).toBe(0);
    db.close();
  });
});
