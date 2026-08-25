-- Trade-show lead processing service — SQLite schema (PRD Section 5).
-- Applied idempotently on startup by db/index.ts (CREATE TABLE IF NOT EXISTS).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Sessions: one per closed per-author idle-buffer. `status` drives the lead
-- state machine (received -> segmented -> ... -> done | failed).
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,          -- deterministic sessionId
  author_email      TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  closed_at         TEXT NOT NULL,
  status            TEXT NOT NULL,             -- session-level pipeline status
  raw_payload_json  TEXT NOT NULL,             -- canonical SessionBundle
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency ledger: THE source of truth for "already handled" (PRD 10.4).
-- Checked before segmentation even runs.
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Leads: one per segment that passed the non-lead filter.
CREATE TABLE IF NOT EXISTS leads (
  id                     TEXT PRIMARY KEY,     -- local uuid-ish id
  session_id             TEXT NOT NULL,
  bitrix_lead_id         INTEGER,              -- null until written
  title                  TEXT,
  status                 TEXT NOT NULL,        -- lead state machine step
  fields_json            TEXT,                 -- gated extraction + mapped ids
  transcript_verbatim    TEXT,                 -- COMMENTS source, never replaced
  ai_summary_ru          TEXT,                 -- timeline comment source
  warnings_json          TEXT,                 -- string[]
  needs_attachment_retry INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_leads_session ON leads(session_id);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);

-- Teams author -> Bitrix owner (PRD Section 10.5).
CREATE TABLE IF NOT EXISTS employee_map (
  teams_email   TEXT PRIMARY KEY,
  bitrix_user_id INTEGER NOT NULL,
  display_name  TEXT
);

-- Cache of crm.lead.userfield.list values (PRD Section 9).
CREATE TABLE IF NOT EXISTS list_value_cache (
  field_code TEXT NOT NULL,
  label      TEXT NOT NULL,
  bitrix_id  INTEGER NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (field_code, label)
);

-- Exhibition name + lead source, set once per period (PRD Section 9).
CREATE TABLE IF NOT EXISTS campaign_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Platform leads: the console's own lead store (LEAD_SINK=platform).
-- Mirrors what would otherwise be written to Bitrix24, so the dashboard is the
-- system of record when no CRM is attached. `local_id` ties a row back to the
-- pipeline's `leads` row, which carries confidence/provenance/source messages.
CREATE TABLE IF NOT EXISTS platform_leads (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  local_id         TEXT NOT NULL UNIQUE,
  session_id       TEXT NOT NULL,
  title            TEXT,
  name             TEXT,
  company          TEXT,
  position         TEXT,
  country          TEXT,
  owner_id         INTEGER,
  status_id        TEXT NOT NULL DEFAULT 'NEW',
  lead_type        TEXT,
  region           TEXT,
  exhibition       TEXT,
  product_interest TEXT,
  priority         TEXT,
  phones_json      TEXT NOT NULL DEFAULT '[]',
  emails_json      TEXT NOT NULL DEFAULT '[]',
  verbatim         TEXT,
  ai_summary       TEXT,
  teams_author     TEXT,
  -- Mirror state for LEAD_SINK=both. The platform row is the primary record;
  -- these track whether the same lead also reached Bitrix24. A failed mirror is
  -- recorded, never thrown, so the lead is never lost locally.
  bitrix_lead_id   INTEGER,
  bitrix_synced_at TEXT,
  bitrix_error     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_platform_leads_author  ON platform_leads(teams_author);
CREATE INDEX IF NOT EXISTS idx_platform_leads_created ON platform_leads(created_at);
