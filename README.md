# Trade-Show Lead Processing Service

Turns a raw **Microsoft Teams** message stream (field managers dropping text,
business-card photos, and voice notes in any order) into correct **Bitrix24**
leads — one contact, one lead, owned by the manager who brought it in, with zero
manual steps on the happy path.

Built to `PRD-lead-service-FINAL-for-Claude-Code.md`. See
[`docs/architecture.md`](docs/architecture.md) and
[`docs/decisions.md`](docs/decisions.md).

> **Status:** running **live end-to-end** — Microsoft Graph ingestion → Gemini
> segmentation/extraction/OCR → real Bitrix24 leads, with an operations console
> on top. Verified against a real Teams channel and a real portal.
>
> Still mocked: ASR (fixtures carry transcripts) and attachment bytes, both
> pending tenant permissions — see *Known limits* below.

## Requirements

- Node.js **22+** (uses the built-in `node:sqlite`)
- No native build step; no `npm install` of heavy deps beyond dev tooling.

## Setup

```bash
npm install
cp .env.example .env      # fill in real values; .env is gitignored
```

All modes default to `mock` in `.env.example`, so the service runs with **no
credentials at all** for development and testing. Secrets (Bitrix webhook,
DeepSeek key, Graph client secret) live only in `.env` — never logged, never
committed (PRD Section 13).

## Run the demo (mock, no external systems)

```bash
npm run generate-fixtures   # build the synthetic dataset + ground truth
npm run run-fixtures        # feed fixtures through the full pipeline -> mock Bitrix
npm run metrics             # Section-15 accuracy metrics vs ground truth
npm run bench-drain         # 400-lead rate-limited drain (virtual-clock timing)
```

`metrics` prints lead-count accuracy, field precision, the headline
cross-contamination rate, Partner precision/recall, and non-lead FP/FN.

## Running permanently

The service polls the Teams channel continuously and writes leads to Bitrix24.

```bash
npm run watch      # continuous poll (foreground); npm run poll for one shot
```

For unattended operation two Windows scheduled tasks run at logon, each
restarting every 5 minutes if it stops. Both read the same `.env` and the same
SQLite database, so the console always shows what the poller just produced.

| Task | Runs | Log |
|---|---|---|
| `LeadService` | `scripts/run-service.cmd` — the Teams → Bitrix24 poller | `logs/service.log` |
| `LeadServiceUI` | `scripts/run-ui.cmd` — the operations console on `:4318` | `logs/ui.log` |

```powershell
Get-ScheduledTask -TaskName LeadService,LeadServiceUI | Select TaskName,State
```

```powershell
Get-Content .\logs\service.log -Tail 40 -Wait
```

Use `Start-ScheduledTask` / `Stop-ScheduledTask` with either name to control them
individually — stopping `LeadService` halts CRM writes while leaving the console
readable.

**Durability.** The poll watermark is persisted and is deliberately **not**
advanced past a session that failed, so transient provider errors cause a retry
on the next poll rather than a silently lost lead. Message-level idempotency
(`processed_messages`) makes any re-poll safe.

> ⚠️ **Quota ceiling.** On the Gemini **free tier** the pipeline is capped at
> ~20 requests/day/model (≈7-10 sessions). Continuous operation will exhaust it
> and sessions will fail with 429 until the daily reset — they are retried
> automatically afterwards. For real show volume enable paid Gemini billing, or
> fund the DeepSeek account and set `LLM_PROVIDER=deepseek`. Either is an `.env`
> change only.

## Ops view (Should-tier, read-only)

```bash
npm run start:api           # serves the read-only lead view + resend on :API_PORT
```

Open `http://localhost:<API_PORT>/`, enter `API_SHARED_SECRET`, and browse leads
(status, warnings, verbatim, AI summary, source messages). `failed` leads have a
resend action. Auth is a single shared secret (header `x-api-secret` or `?secret`).

## Test

```bash
npm test          # vitest: unit + integration, incl. the idempotency suite
npm run typecheck # tsc --noEmit (strict)
```

## What works

- **Ingestion** — app-only Microsoft Graph polling of a Teams channel, including
  thread replies; author resolved to an email; system/bot messages skipped (S4).
- **Grouping** — per-author idle-timer buffering (4 min idle, 15 min cap) then
  LLM segmentation of the buffer into 1..N distinct contacts (S6).
- **Extraction** — one call per segment for fields, Partner/Customer, and a
  Russian summary; confidence gating plus deterministic validators, so a value is
  written only when it is both confident *and* well-formed (S8).
- **Provenance** — every written value is linked back to the exact source message
  it was read from, resolved in code rather than asked of the model (S7).
- **Mapping** — free text → Bitrix list IDs, exact → synonym → fuzzy → blank,
  with IDs fetched live rather than hard-coded (S9).
- **Owner** — lead assigned to the manager who posted, with a flagged fallback
  when unmapped (S10.5).
- **CRM writes** — batched, globally rate-limited at 2 req/s, per-sub-call
  backoff, author-scoped dedup, and new leads forced to the `NEW` funnel status.
- **Idempotency** — re-run ⇒ `noop`; crash before the ledger commit ⇒ no
  duplicates; overlapping backfill ⇒ only genuinely new messages (S10.4).
- **Operations console** — lead list/detail with confidence, evidence, source
  timeline, duplicate and unresolved workspaces, analytics, and admin screens.

## Known limits

- **Attachment bytes** need `Files.Read.All`; until granted, card photos and
  voice clips are flagged `attachmentPending` and the lead is created anyway.
- **Replies to Teams** need `ChannelMessage.Send`; until granted the reply is
  logged rather than posted, and never fails the lead.
- **ASR** is still fixture-backed — the adapter is in place for a real provider.
- **LLM quota** — see the ceiling note above; this is the practical blocker to
  running a full-size show.

## Layout

```
server/src/   contracts, config, db, ingestion, grouping, extraction, provenance,
              ocr, asr, mapping, identity, llm, msgraph, bitrix, pipeline, api
server/test/  vitest suites (120 tests)
web/          operations console — vanilla ES modules, no build step
scripts/      fixtures, metrics, benchmarks, poller, service launchers
fixtures/     scenarios/*.json, ground-truth.json
deploy/       systemd unit + VPS bootstrap
docs/         architecture.md, decisions.md, deployment.md
```
