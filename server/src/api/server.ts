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
import { BitrixRepo } from './bitrixRepo.js';
import { PlatformRepo } from './platformRepo.js';
import { AuthStore, type Account, type Role } from '../auth/store.js';
import { passwordProblem } from '../auth/passwords.js';
import { createHttpTransport } from '../bitrix/transport.js';
import { buildApp } from '../app.js';

/**
 * The console's read model. Both the platform store and the Bitrix portal
 * satisfy it, so the routes below are identical whichever sink is configured.
 */
export type LeadRepo = Pick<
  BitrixRepo,
  'leads' | 'lead' | 'duplicates' | 'analytics' | 'needsAttention' | 'reference'
>;

/** Statuses the console may set. Anything else is rejected rather than stored. */
const ALLOWED_STATUSES = new Set(['NEW', 'IN_PROCESS', 'CONVERTED', 'JUNK']);

/** Structural view of the wired app this server needs (buildApp / buildMockApp). */
export interface ApiApp {
  db: Db;
  pipeline: Pipeline;
  /** Lead sink, when the server is allowed to write status changes. */
  bitrix?: {
    setLeadStatus?(id: number, statusId: string): Promise<void>;
    deleteLead?(id: number): Promise<void>;
    mergeLeads?(survivorId: number, duplicateId: number): Promise<void>;
  };
}

/** Only the secret is required to gate the API. */
export interface ApiServerConfig {
  apiSharedSecret: string;
  /** Which store backs the console: the platform's own, or the Bitrix portal. */
  leadSink?: 'platform' | 'bitrix' | 'both';
  /** Portal webhook. When absent the CRM-backed routes report unavailable. */
  bitrixWebhookUrl?: string;
  campaignExhibition?: string;
  campaignSource?: string;
  /** Operational context for the admin screens (never includes secrets). */
  system?: Record<string, unknown>;
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
  // The app ships as raw ES modules with no build step and no content hashes in
  // filenames, so a cached module is indistinguishable from a current one. With
  // plain 'no-cache' (revalidate) and no validator to revalidate against,
  // browsers kept serving old modules and the console appeared not to change
  // after a deploy. 'no-store' costs a few KB per load and removes the class of
  // bug entirely. Static assets, whose contents do not change, stay cacheable.
  const isCode = ext === '.html' || ext === '.js' || ext === '.css';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isCode ? 'no-store, must-revalidate' : 'public, max-age=86400',
  });
  res.end(body);
  return true;
}

/**
 * Parse the poller's log into structured entries.
 *
 * The log is plain console output, so this reads the shapes the poller emits
 * rather than pretending to be a log framework: polls, sessions, per-lead
 * results, warnings and errors. Unrecognised lines are kept as plain text so
 * nothing is silently hidden.
 */
function readServiceLog(limit = 200): Array<Record<string, unknown>> {
  const file = resolve(WEB_ROOT, '../logs/service.log');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // Only the tail is interesting, and the file grows unbounded.
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).slice(-limit * 3);
  const out: Array<Record<string, unknown>> = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    // Structured warnings are emitted as JSON by the Graph client.
    if (t.startsWith('{') && t.includes('"level"')) {
      try {
        const j = JSON.parse(t) as Record<string, unknown>;
        out.push({ kind: 'warn', level: j.level, source: j.src, code: j.code, detail: j.detail, text: t });
        continue;
      } catch { /* fall through to plain text */ }
    }
    if (t.startsWith('Config:')) continue;            // noisy, and already on Diagnostics

    let m: RegExpMatchArray | null;
    if ((m = t.match(/^\[poll\] (\d+) new message/))) {
      out.push({ kind: 'poll', count: Number(m[1]), text: t });
    } else if ((m = t.match(/^(\S+Z) (.+) \[([a-z,]+)\]$/))) {
      out.push({ kind: 'message', ts: m[1], author: m[2], types: m[3]!.split(','), text: t });
    } else if ((m = t.match(/^\[session\] (\S+) — (\d+) item/))) {
      out.push({ kind: 'session', author: m[1], items: Number(m[2]), text: t });
    } else if ((m = t.match(/^status=(\w+) leads=(\d+)/))) {
      out.push({ kind: 'result', status: m[1], leads: Number(m[2]), text: t });
    } else if ((m = t.match(/^• (.+?) -> (\S+)/))) {
      out.push({ kind: 'lead', title: m[1], url: m[2], text: t });
    } else if (t.startsWith('warnings:')) {
      out.push({ kind: 'warn', detail: t.replace(/^warnings:\s*/, ''), text: t });
    } else if (t.startsWith('error:') || t.startsWith('POLL FAILED')) {
      out.push({ kind: 'error', detail: t.replace(/^error:\s*/, ''), text: t });
    } else if (t.startsWith('[quota]')) {
      out.push({ kind: 'quota', text: t });
    } else if (t.startsWith('[watermark]')) {
      out.push({ kind: 'watermark', text: t });
    } else if (t.startsWith('reply:')) {
      out.push({ kind: 'reply', text: t.replace(/^reply:\s*/, '') });
    } else if (t.startsWith('[') || t.startsWith('Bitrix mode') || t.startsWith('Polling since')) {
      out.push({ kind: 'info', text: t });
    }
  }
  return out.slice(-limit).reverse();   // newest first
}

const SESSION_COOKIE = 'leadsession';

/** Parse one cookie value. No dependency, and no need for a full parser. */
function cookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Session cookie attributes.
 *   HttpOnly — page scripts cannot read the token, so an XSS bug cannot steal it
 *   SameSite=Strict — the cookie is not sent on cross-site requests (CSRF)
 *   Path=/ — one session for the whole console
 * `Secure` is added when the request arrived over TLS; forcing it on plain HTTP
 * would silently break the local pilot, which is served over http://localhost.
 */
function sessionCookie(token: string, secure: boolean, maxAgeSec: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
}

/**
 * Read a small JSON request body. Capped: an unbounded read would let one
 * request exhaust memory, and nothing this API accepts is large.
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const MAX_BYTES = 8 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return null;
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
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
  const auth = new AuthStore(db);
  auth.purgeExpired();

  // Read model behind the console. With the platform sink the leads live in
  // this service's own store, so the screens work with no portal attached;
  // with the bitrix sink the portal remains the source of truth.
  const repo: LeadRepo | null =
    config.leadSink === 'platform' || config.leadSink === 'both'
      ? new PlatformRepo({ db, ...(config.bitrixWebhookUrl ? { bitrixWebhookUrl: config.bitrixWebhookUrl } : {}) })
      : config.bitrixWebhookUrl
      ? new BitrixRepo({
          db,
          webhookUrl: config.bitrixWebhookUrl,
          transport: createHttpTransport(config.bitrixWebhookUrl),
        })
      : null;

  /** Guard for every lead-backed route. */
  function requireRepo(res: ServerResponse): LeadRepo | null {
    if (repo) return repo;
    sendJson(res, 503, {
      error: 'crm_unavailable',
      message: 'No lead store is configured, so there is nothing to show yet.',
    });
    return null;
  }

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

    if (!path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // ── Authentication ──────────────────────────────────────
    // Two ways in, both resolved server-side:
    //   1. a login session cookie -> a real account with a real role
    //   2. the shared secret -> machine access (scripts, health checks),
    //      treated as an administrator because it is a deployment credential
    // The browser cannot choose its own role: it is read from the account.
    const sessionToken = cookie(req, SESSION_COOKIE);
    const account = auth.resolve(sessionToken);
    const machine = presentedSecret(req, url) === config.apiSharedSecret;
    const role: Role | null = account ? account.role : machine ? 'admin' : null;

    // Login and the session probe are the only routes reachable unauthenticated.
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readJson(req).catch(() => null);
      const username = typeof body?.['username'] === 'string' ? body['username'] : '';
      const password = typeof body?.['password'] === 'string' ? body['password'] : '';
      const result = username && password ? auth.login(username, password) : null;
      if (!result) {
        // One message for every failure mode, so usernames cannot be probed.
        sendJson(res, 401, { error: 'invalid_credentials', message: 'Wrong username or password.' });
        return;
      }
      res.setHeader('set-cookie', sessionCookie(result.token, isSecureRequest(req), 12 * 3600));
      sendJson(res, 200, { user: result.account });
      return;
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      if (sessionToken) auth.revoke(sessionToken);
      res.setHeader('set-cookie', sessionCookie('', isSecureRequest(req), 0));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/auth/me' && method === 'GET') {
      if (!role) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, {
        user: account ?? { id: 0, username: 'service', displayName: 'Service access', role: 'admin', disabled: false },
      });
      return;
    }

    if (!role) {
      sendJson(res, 401, { error: 'unauthorized', message: 'Sign in to use this console.' });
      return;
    }

    /** Guard for routes only an administrator may use. */
    const requireAdmin = (): boolean => {
      if (role === 'admin') return true;
      sendJson(res, 403, {
        error: 'forbidden',
        message: 'This action needs an administrator account.',
      });
      return false;
    };

    // ── Account administration ──────────────────────────────
    if (path === '/api/auth/users' && method === 'GET') {
      if (!requireAdmin()) return;
      sendJson(res, 200, auth.list());
      return;
    }

    if (path === '/api/auth/users' && method === 'POST') {
      if (!requireAdmin()) return;
      const body = await readJson(req).catch(() => null);
      const username = String(body?.['username'] ?? '').trim();
      const password = String(body?.['password'] ?? '');
      const wanted = body?.['role'] === 'admin' ? 'admin' : 'user';
      if (!username) { sendJson(res, 400, { error: 'bad_request', message: 'Username is required.' }); return; }
      const problem = passwordProblem(password);
      if (problem) { sendJson(res, 400, { error: 'weak_password', message: problem }); return; }
      if (auth.findByUsername(username)) {
        sendJson(res, 409, { error: 'exists', message: 'That username is already taken.' });
        return;
      }
      sendJson(res, 201, auth.create({
        username, password, role: wanted as Role,
        displayName: String(body?.['displayName'] ?? username),
      }));
      return;
    }

    const userRoute = /^\/api\/auth\/users\/(\d+)$/.exec(path);
    if (userRoute && (method === 'PATCH' || method === 'POST')) {
      if (!requireAdmin()) return;
      const id = Number(userRoute[1]);
      const body = await readJson(req).catch(() => null);
      if (typeof body?.['password'] === 'string') {
        const problem = passwordProblem(body['password'] as string);
        if (problem) { sendJson(res, 400, { error: 'weak_password', message: problem }); return; }
        auth.setPassword(id, body['password'] as string);
      }
      if (body?.['role'] === 'admin' || body?.['role'] === 'user') {
        // An administrator must not remove their own last route back in.
        if (account && account.id === id && body['role'] === 'user') {
          sendJson(res, 400, { error: 'bad_request', message: 'You cannot remove your own administrator role.' });
          return;
        }
        auth.setRole(id, body['role'] as Role);
      }
      if (typeof body?.['disabled'] === 'boolean') {
        if (account && account.id === id && body['disabled']) {
          sendJson(res, 400, { error: 'bad_request', message: 'You cannot disable your own account.' });
          return;
        }
        auth.setDisabled(id, body['disabled'] as boolean);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── CRM-backed routes: the console reads the portal, not fixtures ──
    if (method === 'GET' && path === '/api/crm/leads') {
      const r = requireRepo(res); if (!r) return;
      sendJson(res, 200, await r.leads());
      return;
    }
    const crmLead = /^\/api\/crm\/leads\/(\d+)$/.exec(path);
    if (method === 'GET' && crmLead) {
      const r = requireRepo(res); if (!r) return;
      const lead = await r.lead(Number(crmLead[1]));
      if (!lead) { sendJson(res, 404, { error: 'not found' }); return; }
      sendJson(res, 200, lead);
      return;
    }
    if (method === 'GET' && path === '/api/crm/analytics') {
      const r = requireRepo(res); if (!r) return;
      sendJson(res, 200, await r.analytics());
      return;
    }
    if (method === 'GET' && path === '/api/crm/duplicates') {
      const r = requireRepo(res); if (!r) return;
      sendJson(res, 200, await r.duplicates());
      return;
    }
    if (method === 'GET' && path === '/api/crm/attention') {
      const r = requireRepo(res); if (!r) return;
      sendJson(res, 200, await r.needsAttention());
      return;
    }
    // The one write the console offers: move a lead along its own funnel.
    const statusRoute = /^\/api\/crm\/leads\/(\d+)\/status$/.exec(path);
    if (statusRoute && (method === 'POST' || method === 'PATCH')) {
      const id = Number(statusRoute[1]);
      const body = await readJson(req).catch(() => null);
      const statusId = typeof body?.['statusId'] === 'string' ? body['statusId'] : '';
      if (!ALLOWED_STATUSES.has(statusId)) {
        sendJson(res, 400, {
          error: 'bad_status',
          message: `statusId must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
        });
        return;
      }
      if (!app.bitrix?.setLeadStatus) {
        sendJson(res, 503, {
          error: 'not_supported',
          message: 'This lead store cannot change statuses.',
        });
        return;
      }
      try {
        await app.bitrix.setLeadStatus(id, statusId);
        sendJson(res, 200, { ok: true, id, statusId });
      } catch {
        sendJson(res, 502, {
          error: 'status_failed',
          message: 'The status could not be saved.',
        });
      }
      return;
    }

    // ── Deleting a lead ─────────────────────────────────────
    // Administrator only, and destructive: it also removes the copy this
    // service created in Bitrix24, so no orphan is left for the sales team.
    const deleteRoute = /^\/api\/crm\/leads\/(\d+)$/.exec(path);
    if (deleteRoute && method === 'DELETE') {
      if (!requireAdmin()) return;
      if (!app.bitrix?.deleteLead) {
        sendJson(res, 503, { error: 'not_supported', message: 'This lead store cannot delete leads.' });
        return;
      }
      try {
        await app.bitrix.deleteLead(Number(deleteRoute[1]));
        sendJson(res, 200, { ok: true, id: Number(deleteRoute[1]) });
      } catch (e) {
        // The local delete may have succeeded while the portal failed; say so
        // rather than reporting a clean success or a total failure.
        sendJson(res, 502, {
          error: 'delete_partial',
          message: e instanceof Error ? e.message : 'The lead could not be deleted.',
        });
      }
      return;
    }

    // ── Duplicate decisions ─────────────────────────────────
    const dupRoute = /^\/api\/crm\/duplicates\/(\d+)-(\d+)\/(merge|dismiss)$/.exec(path);
    if (dupRoute && method === 'POST') {
      const left = Number(dupRoute[1]);
      const right = Number(dupRoute[2]);
      const action = dupRoute[3];
      const key = `${Math.min(left, right)}-${Math.max(left, right)}`;
      const who = account?.username ?? 'service';

      if (action === 'dismiss') {
        // Not a duplicate: remember the decision so the pair stops resurfacing.
        db.handle
          .prepare(`INSERT INTO duplicate_decisions (pair_key, decision, decided_by)
                    VALUES (?, 'not_duplicate', ?)
                    ON CONFLICT(pair_key) DO UPDATE SET
                      decision = 'not_duplicate', merged_into = NULL,
                      decided_by = excluded.decided_by, decided_at = datetime('now')`)
          .run(key, who);
        sendJson(res, 200, { ok: true, decision: 'not_duplicate' });
        return;
      }

      // Merging destroys one record, so it is an administrator action.
      if (!requireAdmin()) return;
      if (!app.bitrix?.mergeLeads) {
        sendJson(res, 503, { error: 'not_supported', message: 'This lead store cannot merge leads.' });
        return;
      }
      const body = await readJson(req).catch(() => null);
      // The survivor defaults to the lower id (the earlier lead), unless asked.
      const survivor = Number(body?.['survivorId'] ?? Math.min(left, right));
      const duplicate = survivor === left ? right : left;
      if (survivor !== left && survivor !== right) {
        sendJson(res, 400, { error: 'bad_request', message: 'survivorId must be one of the pair.' });
        return;
      }
      try {
        await app.bitrix.mergeLeads(survivor, duplicate);
        db.handle
          .prepare(`INSERT INTO duplicate_decisions (pair_key, decision, merged_into, decided_by)
                    VALUES (?, 'merged', ?, ?)
                    ON CONFLICT(pair_key) DO UPDATE SET
                      decision = 'merged', merged_into = excluded.merged_into,
                      decided_by = excluded.decided_by, decided_at = datetime('now')`)
          .run(key, survivor, who);
        sendJson(res, 200, { ok: true, decision: 'merged', survivorId: survivor });
      } catch (e) {
        sendJson(res, 502, {
          error: 'merge_failed',
          message: e instanceof Error ? e.message : 'The leads could not be merged.',
        });
      }
      return;
    }

    // Recent service activity, parsed from the poller's log file.
    // Admin-facing: it names leads, which the operator can already see.
    if (method === 'GET' && path === '/api/logs') {
      if (!requireAdmin()) return;
      sendJson(res, 200, { entries: readServiceLog(Number(url.searchParams.get('limit') ?? 200)) });
      return;
    }

    // Operational state for the admin screens. Secrets are never included —
    // only whether a credential is configured.
    if (method === 'GET' && path === '/api/system') {
      if (!requireAdmin()) return;
      const leads = db.listLeads();
      sendJson(res, 200, {
        ...(config.system ?? {}),
        queues: {
          failed: leads.filter((l) => l.status === 'failed').length,
          needsAttachmentRetry: leads.filter((l) => l.needs_attachment_retry === 1).length,
          processed: leads.filter((l) => l.status === 'done').length,
        },
        watermark: db.getCampaign('graph_watermark'),
        employeeMap: db.handle
          .prepare('SELECT teams_email, bitrix_user_id, display_name FROM employee_map')
          .all(),
      });
      return;
    }

    if (method === 'GET' && path === '/api/crm/reference') {
      const r = requireRepo(res); if (!r) return;
      const ref = await r.reference();
      sendJson(res, 200, {
        ...ref,
        campaign: {
          // The project name shown in the top bar. It is no longer stamped on
          // leads — exhibition was removed as a lead field.
          name: config.campaignExhibition ?? null,
          source: config.campaignSource ?? null,
        },
      });
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
      // Surfaced explicitly so the UI does not have to reach into fields.gated.
      confidence: (parseJson(lead.fields_json) as { gated?: { confidence?: unknown } } | null)?.gated?.confidence ?? null,
      provenance: (parseJson(lead.fields_json) as { gated?: { provenance?: unknown } } | null)?.gated?.provenance ?? null,
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
  const server = createApiServer(app, {
    apiSharedSecret: cfg.apiSharedSecret,
    leadSink: cfg.leadSink,
    ...(cfg.bitrixWebhookUrl ? { bitrixWebhookUrl: cfg.bitrixWebhookUrl } : {}),
    campaignExhibition: cfg.campaignExhibition,
    campaignSource: cfg.campaignSource,
    system: {
      leadSink: cfg.leadSink,
      modes: {
        msgraph: cfg.msgraphMode, bitrix: cfg.bitrixMode,
        llm: cfg.llmMode, ocr: cfg.ocrMode, asr: cfg.asrMode,
      },
      providers: { llm: cfg.llmProvider, ocr: cfg.ocrProvider, model: cfg.geminiModel },
      credentials: {
        bitrixWebhook: cfg.bitrixWebhookUrl.length > 0,
        graph: cfg.graph.clientSecret.length > 0,
        gemini: cfg.geminiApiKey.length > 0,
        deepseek: cfg.deepseekApiKey.length > 0,
      },
      channel: { teamsGroupId: cfg.graph.teamsGroupId, channelId: cfg.graph.channelId },
      campaign: { name: cfg.campaignExhibition, source: cfg.campaignSource },
      tuning: {
        idleTimeoutMs: cfg.idleTimeoutMs, maxSessionDurationMs: cfg.maxSessionDurationMs,
        pollIntervalMs: cfg.pollIntervalMs, confidenceThreshold: cfg.confidenceThreshold,
        defaultOwnerId: cfg.bitrixDefaultOwnerId,
      },
    },
  });
  server.listen(cfg.apiPort, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${cfg.apiPort} (auth required: x-api-secret / ?secret)`);
  });
}

// Run when invoked directly (tsx server/src/api/server.ts), not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  startApi();
}
