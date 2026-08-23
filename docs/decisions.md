# Decisions Log

Living record of the calls made while building the trade-show lead service,
including anything that diverged from `PRD-lead-service-FINAL-for-Claude-Code.md`
and why. Newest decisions first within each section.

## Deviations from the PRD

### D1. OCR is a separate adapter, not folded into the LLM vision call — DeepSeek has no vision
- **PRD position (S7):** the business-card image is passed into the LLM's vision
  input in the *same* extraction call, so card and voice reconcile in one pass.
- **Reality:** the chosen LLM is **DeepSeek** (`deepseek-chat` / `deepseek-reasoner`),
  which accepts no image input. The single-fused-call design is not implementable.
- **Decision:** keep `ocr/` as its own adapter (`OcrClient`). In `fixture` mode it
  returns the card text supplied on the image item, exactly as a real vision step
  would. Real card reading (deferred) will use a **separate vision model** (Gemini
  proposed) feeding text into DeepSeek. Card↔voice reconciliation is preserved in
  code via the source-priority rule (card > text > voice), not lost.
- **Status:** confirmed with owner (Q1). Real-OCR provider (Gemini vs other vs
  skip) still open — does **not** block mock development.

### D2. Confidence gating adds deterministic validators on top of model self-confidence
- **PRD position (S8):** fields below a per-field model confidence threshold (0.6)
  are written as `null`.
- **Concern:** LLM self-reported confidence is poorly calibrated; trusting it alone
  under-serves the Accuracy metric.
- **Decision:** keep the confidence gate **and** add cheap deterministic validators
  as a second gate (email/phone format regex; digit-count bounds). A value must pass
  *both* to be written. This only ever makes "empty beats wrong" stronger; the
  external contract is unchanged. Recorded as a deliberate deviation.

### D3. Non-lead filter keys on concrete signals, not the AI summary
- **PRD position (S6):** a segment is a non-lead if it has none of name / phone /
  email / substantive description.
- **Finding:** the AI `summaryRu` is *always* generated (even a generic placeholder),
  so using it as the "substantive description" signal let pure noise through as a
  lead (caught by the fixture batch: `non-lead-noise` produced a lead).
- **Decision:** base the filter on concrete extracted signals — name, phone, email,
  or `productInterest`/`priority`. The verbatim is still preserved regardless.

## Stage 2 additions

### S2.1 Real adapters built behind existing interfaces, still mock-first
DeepSeek (`llm/deepseek`), Gemini OCR (`ocr/gemini`), and the real Bitrix REST
client (`bitrix/real`) are implemented and unit-tested against **stubbed
transports** — no live network in tests, no live Bitrix write. `buildApp` selects
real vs mock per env mode; a fully-mock run needs zero credentials.

### S2.2 DeepSeek strict-JSON handling (S8)
`response_format: json_object`, `temperature: 0`. Malformed output retried up to
2× (feeding the bad output back with a correction nudge); a third failure throws
so the pipeline fails that segment loudly with verbatim preserved. Segmentation
validator filters unknown ids and appends a catch-all segment so no message is
silently dropped.

### S2.3 Bitrix batch + backoff granularity (S10.3)
Writes go out as `batch` requests (add/update lead + timeline comment per lead),
chunked by `BITRIX_BATCH_SIZE` (13) to stay well under 50 sub-calls. Throttling
errors (QUERY_LIMIT_EXCEEDED / OPERATION_TIME_LIMIT / HTTP 503/429) are retried
with exponential backoff **at the granularity of the failing lead's sub-calls**,
not the whole batch. One global token-bucket limiter (2 req/s) gates every call.

### S2.4 Gemini needs a key to run live
`GEMINI_API_KEY` is not yet provided, so `OCR_MODE=gemini` is implemented and
tested but cannot run live until a key is added to `.env`. Fixture OCR remains the
default and covers all card scenarios for development.

## Engineering decisions (PRD-open or PRD-silent)

### E1. Grouping window (PRD's own open question, S6)
Idle timer `IDLE_TIMEOUT = 4 min` + hard cap `MAX_SESSION_DURATION = 15 min`,
buffered **per author**, then LLM segmentation for the 1..N split. Values are
env-configurable and non-blocking to change.

### E2. Deterministic `sessionId` (S4)
`teams|<latestItemTimestamp>|<sha256(sortedMessageIds)[0:16]>`. The timestamp
component is derived from the messages (their latest timestamp), **not** wall-clock
at close time, so the id is fully reproducible across re-runs. Idempotency's real
source of truth remains the `processed_messages` ledger, not the id.

### E3. SQLite via built-in `node:sqlite` (no `better-sqlite3`)
Node 22+ ships `node:sqlite`, removing a native-build dependency. Loaded via a
runtime `require` because bundler resolvers (Vite/Vitest) don't yet recognize the
new builtin and try to load it as a source file.

### E4. Idempotency + resumability mechanics (S5, S10.4)
- `processed_messages` checked **before** segmentation; all-present ⇒ `noop`
  (no write, no reply). Partial overlap ⇒ already-processed messageIds filtered,
  only new ones proceed.
- Lead rows use the deterministic `localId` (`<sessionId>#<segmentId>`) and are
  **upserted**, so a crash between the Bitrix write and the ledger commit resumes
  on restart without duplicating rows. Content dedup (same-owner) then updates the
  existing Bitrix lead rather than creating a second.

### E5. Two leads for one visitor across two managers is intentional (S10.4/10.5)
Owner = message author. Content dedup only merges within the **same** owner; a
different owner always yields a separate lead. Verified by test.

## Non-blocking defaults in force
TypeScript + ESM, run via `tsx`; tests via `vitest`. Poll interval 20s; confidence
threshold 0.6; Bitrix rate limit 2 req/s; batch size 13 leads (~50 sub-calls).
Campaign constants (exhibition, source) from env, applied to every lead.

## Open items (tracked, not blocking mock development)
- **Real OCR provider** (D1): Gemini vs other vs skip.
- **Microsoft Graph** ingestion (auth path + creds) — deferred, mock in place (Q2).
- **ASR** provider — deferred, fixture transcripts in place (Q3).
- **Bitrix go-live**: webhook is configured but `BITRIX_MODE=mock` until mock
  tests are approved for a live write.
