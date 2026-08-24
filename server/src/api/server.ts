/**
 * Minimal read-only operational surface (PRD Section 12, Should-tier).
 *
 * A tiny Node `http` server (no framework) exposing a secret-gated JSON API over
 * the lead store plus a single-file operator page. It is read-only apart from
 * one action: re-driving a failed lead's session back through the (idempotent)
 * pipeline.
 *
 * Secrets/PII are never logged — startup logs only the port and a redacted note.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.js';
import type { Pipeline } from '../pipeline/index.js';
import type { SessionBundle } from '../contracts/index.js';
import { loadConfig } from '../config/index.js';
import { buildApp } from '../app.js';

/** Structural view of the wired app this server needs (buildApp / buildMockApp). */
export interface ApiApp {
  db: Db;
  pipeline: Pipeline;
}

/** Only the secret is required to gate the API. */
export interface ApiServerConfig {
  apiSharedSecret: string;
}

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web');
const WEB_INDEX = resolve(WEB_ROOT, 'index.html');

/** Content types for the static assets the operator UI is built from. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/**
 * Serve a file from web/. Returns false when there is nothing to serve so the
 * caller can fall through to the API routes / 404.
 *
 * The resolved path is confined to WEB_ROOT, so a crafted URL such as
 * `/../../.env` cannot escape the web directory.
 */
function serveStatic(res: ServerResponse, pathname: string): boolean {
  const target = resolve(WEB_ROOT, '.' + pathname);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return false;
  let body: Buffer;
  try {
    const st = statSync(target);
    if (!st.isFile()) return false;
    body = readFileSync(target);
  } catch {
    return false;
  }
  const ext = extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // The UI is developed live; never let a stale module linger.
    'cache-control': 'no-cache',
  });
  res.end(body);
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Extract the shared secret from the `x-api-secret` header or `?secret=`. */
function presentedSecret(req: IncomingMessage, url: URL): string | null {
  const header = req.headers['x-api-secret'];
  if (typeof header === 'string' && header.length > 0) return header;
  const q = url.searchParams.get('secret');
  return q && q.length > 0 ? q : null;
}

interface LeadListItem {
  id: string;
  title: string | null;
  status: string;
  bitrixLeadId: number | null;
  needsAttachmentRetry: boolean;
  sessionId: string;
  createdAt: string;
}

function parseJson(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sourceMessagesFor(db: Db, sessionId: string): SessionBundle['items'] {
  const session = db.getSession(sessionId);
  if (!session) return [];
  const bundle = parseJson(session.raw_payload_json) as SessionBundle | null;
  return bundle?.items ?? [];
}

export function createApiServer(app: ApiApp, config: ApiServerConfig): Server {
  const { db, pipeline } = app;

  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      // Never leak an error message (may carry PII) — generic 500.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ── Unauthenticated routes ──────────────────────────────
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && path === '/') {
      const html = readFileSync(WEB_INDEX, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── Static assets for the operator UI (unauthenticated, like `/`) ──
    if (method === 'GET' && !path.startsWith('/api/') && serveStatic(res, path)) {
      return;
    }

    // ── Everything under /api requires the shared secret ────
    if (path.startsWith('/api/')) {
      if (presentedSecret(req, url) !== config.apiSharedSecret) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
    } else {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // GET /api/leads
    if (method === 'GET' && path === '/api/leads') {
      const items: LeadListItem[] = db.listLeads().map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        bitrixLeadId: r.bitrix_lead_id,
        needsAttachmentRetry: r.needs_attachment_retry === 1,
        sessionId: r.session_id,
        createdAt: r.created_at,
      }));
      sendJson(res, 200, items);
      return;
    }

    // /api/leads/:id  and  /api/leads/:id/resend
    const leadMatch = /^\/api\/leads\/([^/]+)(\/resend)?$/.exec(path);
    if (leadMatch) {
      const id = decodeURIComponent(leadMatch[1]!);
      const isResend = leadMatch[2] === '/resend';

      if (isResend) {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        await handleResend(res, id);
        return;
      }

      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      handleDetail(res, id);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function handleDetail(res: ServerResponse, id: string): void {
    const lead = db.getLead(id);
    if (!lead) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    sendJson(res, 200, {
      id: lead.id,
      title: lead.title,
      status: lead.status,
      bitrixLeadId: lead.bitrix_lead_id,
      needsAttachmentRetry: lead.needs_attachment_retry === 1,
      warnings: parseJson(lead.warnings_json) ?? [],
      fields: parseJson(lead.fields_json),
      verbatim: lead.transcript_verbatim,
      aiSummaryRu: lead.ai_summary_ru,
      sourceMessages: sourceMessagesFor(db, lead.session_id),
    });
  }

  async function handleResend(res: ServerResponse, id: string): Promise<void> {
    const lead = db.getLead(id);
    if (!lead) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (lead.status !== 'failed') {
      sendJson(res, 409, { error: 'lead is not in failed state' });
      return;
    }
    const session = db.getSession(lead.session_id);
    if (!session) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const bundle = parseJson(session.raw_payload_json) as SessionBundle | null;
    if (!bundle) {
      sendJson(res, 500, { error: 'internal' });
      return;
    }
    // Re-open the ledger for this session, then re-drive the idempotent pipeline.
    db.clearProcessedForSession(lead.session_id);
    const result = await pipeline.processSession(bundle);
    sendJson(res, 200, { result });
  }
}

/** Entry point: load config, wire the app, and listen (secrets never logged). */
export function startApi(): void {
  const cfg = loadConfig();
  const app = buildApp(cfg);
  const server = createApiServer(app, cfg);
  server.listen(cfg.apiPort, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${cfg.apiPort} (auth required: x-api-secret / ?secret)`);
  });
}

// Run when invoked directly (tsx server/src/api/server.ts), not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  startApi();
}
