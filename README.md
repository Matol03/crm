# Trade-Show Lead Processing Service

Turns a raw **Microsoft Teams** message stream (field managers dropping text,
business-card photos, and voice notes in any order) into correct **Bitrix24**
leads — one contact, one lead, owned by the manager who brought it in, with zero
manual steps on the happy path.

Built to `PRD-lead-service-FINAL-for-Claude-Code.md`. See
[`docs/architecture.md`](docs/architecture.md) and
[`docs/decisions.md`](docs/decisions.md).

> **Status:** the pipeline runs **live end-to-end on Gemini** (free tier) for
> segmentation, extraction, and card OCR, writing to **mock Bitrix** — verified on
> real fixtures (`npm run live-demo`). Bitrix stays mock until its webhook gets the
> CRM scope and go-live is approved. DeepSeek clients remain as an alternate
> provider (account needs balance). Microsoft Graph ingestion and a real ASR
> provider are still deferred (mocks in place).

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

## What works today (Stage 1)

- Deterministic per-author idle-timer buffering → `SessionBundle` (S4/S6).
- LLM segmentation of a buffer into 1..N leads (heuristic mock; S6).
- Extraction + confidence gating + deterministic validators + Partner/Customer
  double-check (S8).
- Reference-list mapping: exact → synonym → fuzzy → blank (S9).
- Owner resolution (author → Bitrix user) with flagged default fallback (S10.5).
- Batched writes through a mock Bitrix client with owner-scoped dedup (S10).
- **Idempotency**: re-run ⇒ `noop`; crash-before-ledger ⇒ no duplicates;
  overlapping backfill ⇒ only new messages (S10.4).
- Manager reply on success/partial; silent on `noop` (S11).

## Deferred (behind adapters, not yet wired to real systems)

- Microsoft Graph ingestion (auth path + creds).
- ASR provider (fixtures carry transcripts today).
- Real OCR vision step (DeepSeek has no vision — see `docs/decisions.md` D1).
- Live Bitrix writes (`BITRIX_MODE=mock` until explicitly approved).

## Layout

```
server/src/   contracts, config, db, ingestion, grouping, extraction,
              ocr, asr, mapping, identity, llm, msgraph, bitrix, pipeline
server/test/  vitest suites
scripts/      generate-fixtures.ts, run-fixture-batch.ts
fixtures/     scenarios/*.json, ground-truth.json
docs/         architecture.md, decisions.md
```
