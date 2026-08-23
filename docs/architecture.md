# Architecture

Node.js/TypeScript service that turns a raw Microsoft Teams message stream into
Bitrix24 leads. Everything below the Teams channel is code, runnable end-to-end
with zero external dependencies in mock mode.

## Data flow

```
Teams channel
   │  (poll, S4 — deferred; mock in place)
   ▼
ingestion/  ── idle-timer buffer, per author (S6 T1) ──► SessionBundle (S4 contract)
   │                                                         deterministic sessionId
   ▼
pipeline/  (orchestrator, S4–S11)
   ├─ idempotency gate: drop processed messageIds (S10.4) ─ all present ⇒ noop
   ├─ attachment resolution: asr.transcribe / ocr.readCard
   ├─ grouping/ : llm.segment → 1..N segments (S6 T2)
   ├─ per segment:
   │    ├─ extraction/ : llm.extract → RawExtraction (S8)
   │    ├─ gating      : confidence + validators + Partner double-check (S8, D2)
   │    ├─ non-lead filter (S6, D3)
   │    ├─ mapping/    : free text → Bitrix list IDs (S9)
   │    └─ identity/   : author email → Bitrix owner (S10.5)
   ├─ bitrix.writeLeads: batched add/update, owner-scoped dedup (S10)
   └─ graph.postReply : manager reply (S11); silent on noop
   ▼
Bitrix24 portal (mock or live)
```

## Modules (`server/src/`)

| Module | Responsibility |
|---|---|
| `contracts/` | Shared types: `SessionBundle`, extraction shape, segmentation, adapter interfaces, Bitrix write contract. The internal API everything else depends on. |
| `config/` | Dependency-free `.env` parser, mode-aware validation, redacted (secret-free) summary. |
| `db/` | `node:sqlite` layer: schema, lead state machine, idempotency ledger, employee map, list cache, campaign config. |
| `ingestion/` | Deterministic `sessionId` + clock-injectable idle-timer buffer (grouped by author). |
| `grouping/`, `extraction/`, `ocr/`, `asr/`, `msgraph/`, `bitrix/` | Adapter seams. Mock impls today; real impls swap in behind the same interfaces. |
| `llm/` | `LlmClient` — segmentation + extraction. Heuristic mock now; DeepSeek later. |
| `mapping/` | Exact → synonym → fuzzy(edit-distance) → null reference-list matching. |
| `identity/` | Teams author → Bitrix owner, flagged default fallback. |
| `pipeline/` | The orchestrator that wires all of the above per session. |
| `metrics/` | Scoring against ground truth: lead-count, field precision, cross-contamination, Partner P/R, non-lead FP/FN (S15). |
| `api/` | Read-only ops HTTP surface (Node `http`, shared-secret gate): lead list/detail + resend on failed (S12). |
| `app.ts` | Mode-selecting wiring (`buildApp`) + all-mock factory (`buildMockApp`) shared by the runner and tests. |

## Adapter seams (why the provider choices don't leak)

Each external system sits behind one interface:
- `MsGraphClient.getNewChannelMessages / postReply`
- `AsrClient.transcribe`
- `OcrClient.readCard`
- `LlmClient.segment / extract`
- `BitrixClient.listUserFieldValues / findDuplicate / writeLeads / getLead / leadUrl`

The pipeline depends only on these interfaces, so mock↔real is a wiring change in
`app.ts`, never a pipeline change.

## State machine (`leads.status`, S5)

`received → segmented → extracted → mapped → dedup_checked → writing_crm → done | failed`

Persisted after each step so a mid-batch restart resumes at the last-completed
step. Combined with the deterministic `localId` upsert and the `processed_messages`
ledger, re-processing is safe by construction.

## Testing

`vitest` unit + integration suite (`server/test/`), including the Section-15
idempotency suite. `scripts/generate-fixtures.ts` builds a deterministic synthetic
set + ground truth; `scripts/run-fixture-batch.ts` runs the whole pipeline against
mock Bitrix and prints self-consistency metrics.
