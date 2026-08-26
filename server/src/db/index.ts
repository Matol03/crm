/**
 * SQLite access layer (PRD Section 5) built on Node's built-in `node:sqlite`
 * (no native build step). Holds the schema bootstrap, the lead state machine,
 * and the idempotency ledger helpers.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { SessionBundle } from '../contracts/index.js';

// `node:sqlite` is a newer built-in that bundler resolvers (Vite/Vitest) don't
// yet recognize and try to load as a source file. Loading it via a runtime
// require sidesteps static import analysis while staying correct under Node/tsx.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Lead state machine (PRD Section 5). Order matters for resumability. */
export const LEAD_STATES = [
  'received',
  'segmented',
  'extracted',
  'mapped',
  'dedup_checked',
  'writing_crm',
  'done',
  'failed',
] as const;
export type LeadState = (typeof LEAD_STATES)[number];

export interface LeadRow {
  id: string;
  session_id: string;
  bitrix_lead_id: number | null;
  title: string | null;
  status: LeadState;
  fields_json: string | null;
  transcript_verbatim: string | null;
  ai_summary_ru: string | null;
  warnings_json: string | null;
  needs_attachment_retry: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  author_email: string;
  opened_at: string;
  closed_at: string;
  status: string;
  raw_payload_json: string;
  created_at: string;
  updated_at: string;
}

export class Db {
  readonly handle: DatabaseSync;

  constructor(dbPath: string) {
    // ':memory:' is used directly by tests; file paths get their dir created.
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.handle = new DatabaseSync(dbPath);
    // The poller and the API server open this file concurrently. Without a busy
    // timeout SQLite fails a contended write instantly ("database is locked")
    // instead of waiting — which killed the API on startup whenever the two
    // raced on applying schema DDL. Wait for the other writer instead.
    this.handle.exec('PRAGMA busy_timeout = 10000');
    this.migrate();
  }

  /** Apply the schema (idempotent — CREATE TABLE IF NOT EXISTS). */
  migrate(): void {
    const sql = readFileSync(SCHEMA_PATH, 'utf8');
    this.handle.exec(sql);
    // Columns added after a database was first created. `CREATE TABLE IF NOT
    // EXISTS` skips an existing table entirely, so new columns must be added
    // separately — and `ALTER TABLE ADD COLUMN` throws if the column is already
    // there, which would break every subsequent startup. Hence the check.
    this.ensureColumn('platform_leads', 'bitrix_lead_id', 'INTEGER');
    this.ensureColumn('platform_leads', 'bitrix_synced_at', 'TEXT');
    this.ensureColumn('platform_leads', 'bitrix_error', 'TEXT');
    this.dropColumn('platform_leads', 'exhibition');
    this.backfillLeadSources();
  }

  /**
   * Seed platform_lead_sources from the single local_id each lead already
   * carries, so existing leads keep working after the table is introduced.
   * Idempotent: INSERT OR IGNORE against the composite primary key.
   */
  private backfillLeadSources(): void {
    const hasTable = this.handle
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'platform_leads'`)
      .get();
    if (!hasTable) return;
    this.handle.exec(
      `INSERT OR IGNORE INTO platform_lead_sources (platform_lead_id, local_id)
       SELECT id, local_id FROM platform_leads WHERE local_id IS NOT NULL`,
    );
  }

  /**
   * Remove a column that is no longer part of the model, when it is still
   * present. Guarded the same way as ensureColumn: DROP COLUMN throws if the
   * column is already gone, which would break every later startup. Failure is
   * tolerated — an unused column is harmless, and refusing to start over one
   * would be worse than leaving it.
   */
  private dropColumn(table: string, column: string): void {
    const exists = this.handle
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);
    if (!exists) return;
    const cols = this.handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) return;
    try {
      this.handle.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch {
      /* Older SQLite without DROP COLUMN: leave it in place, unused. */
    }
  }

  /** Add a column only when the table exists and lacks it. */
  private ensureColumn(table: string, column: string, type: string): void {
    const exists = this.handle
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);
    if (!exists) return;
    const cols = this.handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close(): void {
    this.handle.close();
  }

  // ── Idempotency ledger (PRD Section 10.4) ──────────────────

  /** Which of these messageIds have already been processed. */
  alreadyProcessed(messageIds: string[]): Set<string> {
    const seen = new Set<string>();
    if (messageIds.length === 0) return seen;
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.handle
      .prepare(`SELECT message_id FROM processed_messages WHERE message_id IN (${placeholders})`)
      .all(...messageIds) as Array<{ message_id: string }>;
    for (const r of rows) seen.add(r.message_id);
    return seen;
  }

  /** True when EVERY given message is already in the ledger (=> noop). */
  allProcessed(messageIds: string[]): boolean {
    if (messageIds.length === 0) return true;
    return this.alreadyProcessed(messageIds).size === messageIds.length;
  }

  /**
   * Drop a session's messages from the idempotency ledger so the next
   * `processSession` re-runs them (used by the ops resend route). The pipeline
   * stays idempotent — Bitrix content dedup and the lead upsert make the re-run
   * update-in-place rather than duplicate (PRD Section 12 / 10.4).
   */
  clearProcessedForSession(sessionId: string): void {
    this.handle
      .prepare('DELETE FROM processed_messages WHERE session_id = ?')
      .run(sessionId);
  }

  /** Record messages as processed. Idempotent (INSERT OR IGNORE). */
  markProcessed(messageIds: string[], sessionId: string): void {
    const stmt = this.handle.prepare(
      'INSERT OR IGNORE INTO processed_messages (message_id, session_id) VALUES (?, ?)',
    );
    const tx = this.handle.prepare('BEGIN');
    const commit = this.handle.prepare('COMMIT');
    tx.run();
    try {
      for (const id of messageIds) stmt.run(id, sessionId);
      commit.run();
    } catch (e) {
      this.handle.prepare('ROLLBACK').run();
      throw e;
    }
  }

  // ── Sessions ───────────────────────────────────────────────

  upsertSession(bundle: SessionBundle, status: string): void {
    this.handle
      .prepare(
        `INSERT INTO sessions (id, author_email, opened_at, closed_at, status, raw_payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
      )
      .run(
        bundle.sessionId,
        bundle.author.email,
        bundle.sessionWindow.openedAt,
        bundle.sessionWindow.closedAt,
        status,
        JSON.stringify(bundle),
      );
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.handle.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    return (row as unknown as SessionRow) ?? null;
  }

  setSessionStatus(sessionId: string, status: string): void {
    this.handle
      .prepare(`UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, sessionId);
  }

  // ── Leads (state machine) ──────────────────────────────────

  insertLead(lead: {
    id: string;
    sessionId: string;
    title: string | null;
    status: LeadState;
    fieldsJson: string | null;
    verbatim: string | null;
    aiSummaryRu: string | null;
    warningsJson: string | null;
    needsAttachmentRetry: boolean;
  }): void {
    // Upsert on the deterministic local id so re-processing after a crash/
    // restart resumes rather than failing on a duplicate row (PRD Section 5).
    this.handle
      .prepare(
        `INSERT INTO leads
           (id, session_id, title, status, fields_json, transcript_verbatim,
            ai_summary_ru, warnings_json, needs_attachment_retry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           fields_json = excluded.fields_json,
           transcript_verbatim = excluded.transcript_verbatim,
           ai_summary_ru = excluded.ai_summary_ru,
           warnings_json = excluded.warnings_json,
           needs_attachment_retry = excluded.needs_attachment_retry,
           updated_at = datetime('now')`,
      )
      .run(
        lead.id,
        lead.sessionId,
        lead.title,
        lead.status,
        lead.fieldsJson,
        lead.verbatim,
        lead.aiSummaryRu,
        lead.warningsJson,
        lead.needsAttachmentRetry ? 1 : 0,
      );
  }

  /** Advance (or otherwise set) a lead's state machine step. */
  setLeadStatus(leadId: string, status: LeadState): void {
    this.handle
      .prepare(`UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, leadId);
  }

  setLeadBitrixId(leadId: string, bitrixLeadId: number): void {
    this.handle
      .prepare(`UPDATE leads SET bitrix_lead_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(bitrixLeadId, leadId);
  }

  getLead(leadId: string): LeadRow | null {
    const row = this.handle.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    return (row as unknown as LeadRow) ?? null;
  }

  listLeads(): LeadRow[] {
    return this.handle
      .prepare('SELECT * FROM leads ORDER BY created_at DESC')
      .all() as unknown as LeadRow[];
  }

  getLeadsForSession(sessionId: string): LeadRow[] {
    return this.handle
      .prepare('SELECT * FROM leads WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as unknown as LeadRow[];
  }

  // ── employee_map (PRD Section 10.5) ────────────────────────

  /**
   * Store a mapping. Emails are normalised to lower case because Graph reports
   * the address in whatever case the directory holds it ("M.Askarov@Contoso...")
   * while SQLite compares TEXT case-sensitively — matching on the raw value
   * would silently miss and send every lead to the default owner.
   */
  setEmployee(teamsEmail: string, bitrixUserId: number, displayName: string): void {
    this.handle
      .prepare(
        `INSERT INTO employee_map (teams_email, bitrix_user_id, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT(teams_email) DO UPDATE SET
           bitrix_user_id = excluded.bitrix_user_id, display_name = excluded.display_name`,
      )
      .run(teamsEmail.trim().toLowerCase(), bitrixUserId, displayName);
  }

  /** Look up an owner. Case-insensitive, for the reason above. */
  getBitrixUserId(teamsEmail: string): number | null {
    const row = this.handle
      .prepare('SELECT bitrix_user_id FROM employee_map WHERE teams_email = ?')
      .get(teamsEmail.trim().toLowerCase()) as { bitrix_user_id: number } | undefined;
    return row?.bitrix_user_id ?? null;
  }

  // ── list_value_cache (PRD Section 9) ───────────────────────

  cacheListValues(fieldCode: string, values: Array<{ label: string; id: number }>): void {
    const stmt = this.handle.prepare(
      `INSERT INTO list_value_cache (field_code, label, bitrix_id, fetched_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(field_code, label) DO UPDATE SET
         bitrix_id = excluded.bitrix_id, fetched_at = datetime('now')`,
    );
    for (const v of values) stmt.run(fieldCode, v.label, v.id);
  }

  getCachedListValues(fieldCode: string): Array<{ label: string; bitrix_id: number }> {
    return this.handle
      .prepare('SELECT label, bitrix_id FROM list_value_cache WHERE field_code = ?')
      .all(fieldCode) as Array<{ label: string; bitrix_id: number }>;
  }

  // ── campaign_config (PRD Section 9) ────────────────────────

  setCampaign(key: string, value: string): void {
    this.handle
      .prepare(
        `INSERT INTO campaign_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getCampaign(key: string): string | null {
    const row = this.handle
      .prepare('SELECT value FROM campaign_config WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}
