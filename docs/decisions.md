# Decisions Log

Living record of the calls made while building the trade-show lead service,
including anything that diverged from `PRD-lead-service-FINAL-for-Claude-Code.md`
and why. Newest decisions first within each section.

## Provider decision: Gemini (free) is the live LLM + OCR; DeepSeek is the alternate

DeepSeek has no free tier and the account has zero balance (402 on all
inference), so it cannot run live. Google **Gemini** (`gemini-2.5-flash`) has a
working free tier and is **multimodal**, so it now serves BOTH:
- **Extraction/segmentation** (`llm/gemini.ts`, `LlmClient`)
- **Card OCR** (`ocr/gemini.ts`, `OcrClient`)

One free credential covers the whole live pipeline. Selected via
`LLM_PROVIDER` / `OCR_PROVIDER` (`gemini` | `deepseek`); DeepSeek clients remain
for when that account is funded. Shared JSON validation + `<=2`-retry flow live
in `llm/validate.ts` so both providers behave identically.

**Verified live** (real Gemini, mock Bitrix): the card/voice name-mismatch
(card wins), the partner/reseller classification, and the adversarial three-cards-
back-to-back segmentation all produce correct leads end to end.

Robustness fix found during the live run: `summaryRu` is now defaulted to empty
rather than throwing when the model omits it (a bare card may have nothing to
summarize) — failing a whole lead over a missing *summary* violated "empty beats
wrong". The verbatim record is unaffected.

## Live smoke-test findings (read-only, Stage 3 gate)

Three read-only live probes, all with owner approval. Code/request formats are
correct in every case; the blockers are account/config on the provider side:

- **DeepSeek key: valid, but account has _Insufficient Balance_ (HTTP 402).**
  `GET /models` (free) succeeds and reveals `deepseek-v4-flash`,
  `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`. But any inference call —
  text OR vision — returns 402. **No live LLM/OCR until the account is funded.**
- **Bitrix webhook: authenticates but has NO CRM scope.** `profile` returns 200;
  every `crm.*` method returns **401 insufficient_scope**. **No live CRM read or
  write until the webhook is granted the CRM scope** (recreate/edit the inbound
  webhook with CRM permission).
- Net: all three live integrations are currently blocked by owner-side
  account/config, not by code. Everything remains validated in mock.

## Deviations from the PRD

### D1 (REVISED). OCR uses DeepSeek vision — DeepSeek DOES have a vision model
- **Original call:** DeepSeek (`deepseek-chat`/`reasoner`) had no image input, so
  OCR was made a separate adapter and Gemini was chosen for card reading.
- **Reversal (from smoke test a):** the account's DeepSeek API actually exposes a
  vision model, `deepseek-v4-flash-vision-exp` — so DeepSeek vision OCR was built
  (`ocr/deepseek.ts`). But DeepSeek has no balance, so the **live** OCR provider
  ended up being **Gemini** (see the provider-decision section above); both vision
  clients exist behind the unchanged `OcrClient` seam, `fixture` mode still
  short-circuits on pre-supplied text.
- Card↔voice reconciliation stays enforced in code (source priority, S3.3).
- **Status:** Gemini OCR is live-validated; DeepSeek vision is ready for when that
  account is funded.

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

## Stage 3 additions

### S3.1 Content dedup keys on Teams author, not the resolved owner (bug fix)
The PRD (S10.4) phrases dedup as "same **owner** → update, different owner →
separate." But two *unmapped* managers both fall back to the configured default
owner (S10.5), so keying on owner silently **merged** their two legitimate leads
on the same visitor — violating the Must-tier "two managers → two leads"
guarantee. Found via the ops UI (both Sven Larsson leads showed one Bitrix id).
Fix: dedup-update only when the matched lead's **Teams author** matches; the
author is the real manager identity. Owner is still assigned per author.
Regression test added (two unmapped managers → two leads).

### S3.2 Partner markers restricted to intent-bearing terms
The bare noun "partner" over-triggered on incidental phrasing ("partner booth"),
producing a false Partner (the expensive asymmetric error, S8). Surfaced by the
metrics run (Partner precision 50%). `PARTNER_LEXICAL` / mock `PARTNER_MARKERS`
now require reseller/distributor/partnership-style language; the true-partner
fixtures still match. Partner precision back to 100%.

### S3.3 Source-priority enforced in code for the name field (S8)
Beyond prompting the model to prefer the card, `reconcileName` re-checks the
extracted name against the card's structured `Name:` value: card wins any
conflict, and the discrepancy is logged as a warning (never hidden) — the PRD's
canonical "Aleksandr Ivanovich Petrov" vs "Sasha Petrov" example.

### S3.4 Drain-throughput finding (S15 / S10.3)
The 400-lead drain benchmark (virtual clock) shows per-lead dedup reads
(findbycomm ×2) dominate the call count (~800 vs ~31 write batches) → ~415s
simulated at 2 req/s, vs the ~200s the write path alone predicts. Per session
(1–3 leads) this is negligible and well under the ~1-min reply goal; batching the
dedup lookups is the documented next optimization if full-show drain latency
matters. Not implemented now (write robustness prioritized over drain speed).

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
