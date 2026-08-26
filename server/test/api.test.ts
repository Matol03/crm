import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig } from '../src/config/index.js';
import { buildMockApp } from '../src/app.js';
import { createApiServer } from '../src/api/server.js';
import type { SessionBundle, SessionItem } from '../src/contracts/index.js';
import { makeSessionId } from '../src/ingestion/sessionId.js';

const CFG = loadConfig({
  BITRIX_MODE: 'mock',
  LLM_MODE: 'mock',
  MSGRAPH_MODE: 'mock',
  CAMPAIGN_EXHIBITION: 'Hannover Messe 2026',
});

const CHANNEL = { teamsGroupId: 'g1', channelId: 'c1' };
const IVAN = { teamsUserId: 'u-ivan', email: 'ivan@example.com', displayName: 'Ivan' };

function bundle(author: typeof IVAN, items: SessionItem[]): SessionBundle {
  const ids = items.map((i) => i.messageId);
  const latest = items[items.length - 1]!.timestamp;
  return {
    sessionId: makeSessionId(ids, latest),
    channel: CHANNEL,
    author,
    sessionWindow: { openedAt: items[0]!.timestamp, closedAt: latest },
    items,
  };
}

function card(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
}

const app = buildMockApp(CFG);
let server: Server;
let base: string;

async function get(path: string, secret?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers['x-api-secret'] = secret;
  const res = await fetch(`${base}${path}`, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

beforeAll(async () => {
  app.db.setEmployee('ivan@example.com', 7, 'Ivan');
  // Seed a couple of (done) leads through the real pipeline.
  await app.pipeline.processSession(
    bundle(IVAN, [
      { messageId: 'a1', timestamp: '2026-08-22T10:00:00Z', type: 'text', text: 'interested in analytics' },
      {
        messageId: 'a2',
        timestamp: '2026-08-22T10:00:30Z',
        type: 'image',
        ocrText: card({ Name: 'Anna Weber', Company: 'BMW AG', Country: 'Germany', Email: 'anna@bmw.de', Phone: '+498912345678' }),
      },
    ]),
  );
  await app.pipeline.processSession(
    bundle(IVAN, [
      {
        messageId: 'b1',
        timestamp: '2026-08-22T11:00:00Z',
        type: 'image',
        ocrText: card({ Name: 'Sven Larsson', Company: 'Volvo', Email: 'sven@volvo.se', Phone: '+46812345678' }),
      },
    ]),
  );

  server = createApiServer(app, { apiSharedSecret: 's' });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('api server', () => {
  it('GET /health is ok without a secret', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it('GET /api/leads returns 401 without the secret', async () => {
    const { status, body } = await get('/api/leads');
    expect(status).toBe(401);
    // The body also carries a human-readable message; the contract is the code.
    expect(body).toMatchObject({ error: 'unauthorized' });
  });

  it('GET /api/leads returns 200 + array with the correct secret', async () => {
    const { status, body } = await get('/api/leads', 's');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const leads = body as Array<Record<string, unknown>>;
    expect(leads.length).toBeGreaterThanOrEqual(2);
    const first = leads[0]!;
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('title');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('bitrixLeadId');
    expect(first).toHaveProperty('needsAttachmentRetry');
    expect(first).toHaveProperty('sessionId');
    expect(first).toHaveProperty('createdAt');
  });

  it('GET /api/leads/:id returns detail including sourceMessages', async () => {
    const list = (await get('/api/leads', 's')).body as Array<{ id: string }>;
    const id = list[0]!.id;
    const { status, body } = await get(`/api/leads/${encodeURIComponent(id)}`, 's');
    expect(status).toBe(200);
    const detail = body as Record<string, unknown>;
    expect(detail.id).toBe(id);
    expect(detail).toHaveProperty('fields');
    expect(detail).toHaveProperty('verbatim');
    expect(detail).toHaveProperty('aiSummaryRu');
    expect(detail).toHaveProperty('warnings');
    expect(Array.isArray(detail.sourceMessages)).toBe(true);
    expect((detail.sourceMessages as unknown[]).length).toBeGreaterThan(0);
    const msg = (detail.sourceMessages as Array<Record<string, unknown>>)[0]!;
    expect(msg).toHaveProperty('messageId');
    expect(msg).toHaveProperty('type');
  });

  it('GET /api/leads/:id returns 404 for an unknown id', async () => {
    const { status } = await get('/api/leads/does-not-exist', 's');
    expect(status).toBe(404);
  });

  it('POST /api/leads/:id/resend returns 409 on a non-failed lead', async () => {
    const list = (await get('/api/leads', 's')).body as Array<{ id: string; status: string }>;
    const notFailed = list.find((l) => l.status !== 'failed')!;
    const res = await fetch(`${base}/api/leads/${encodeURIComponent(notFailed.id)}/resend`, {
      method: 'POST',
      headers: { 'x-api-secret': 's' },
    });
    const body = await res.json().catch(() => null);
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'lead is not in failed state' });
  });

  it('POST /api/leads/:id/resend returns 401 without the secret', async () => {
    const list = (await get('/api/leads', 's')).body as Array<{ id: string }>;
    const res = await fetch(`${base}/api/leads/${encodeURIComponent(list[0]!.id)}/resend`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
