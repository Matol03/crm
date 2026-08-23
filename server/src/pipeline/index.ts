/**
 * Session pipeline orchestrator (PRD Sections 4–11).
 *
 * Takes one SessionBundle and drives it through: idempotency gate -> attachment
 * resolution (ASR/OCR) -> LLM segmentation -> per-segment extraction + gating ->
 * non-lead filter -> reference mapping -> owner resolution -> Bitrix write ->
 * reply. Every adapter is injected, so this same orchestrator runs identically
 * against mock or real implementations.
 *
 * Idempotency (S10.4): already-processed messageIds are filtered before
 * segmentation; if none remain the session is a `noop` (no write, no reply).
 */

import type {
  SessionBundle,
  SessionItem,
  PipelineResult,
  PipelineLeadResult,
  MsGraphClient,
  AsrClient,
  OcrClient,
  LlmClient,
  BitrixClient,
  LeadWrite,
} from '../contracts/index.js';
import type { Db } from '../db/index.js';
import { applyGate } from '../extraction/gating.js';
import { isLead } from '../contracts/extraction.js';
import { buildListFields, type Campaign, type ListValuesByField } from '../mapping/leadFields.js';
import { resolveOwner } from '../identity/index.js';

export interface PipelineDeps {
  db: Db;
  graph: MsGraphClient;
  asr: AsrClient;
  ocr: OcrClient;
  llm: LlmClient;
  bitrix: BitrixClient;
  config: {
    confidenceThreshold: number;
    bitrixDefaultOwnerId: number;
    campaignExhibition: string;
    campaignSource: string;
  };
}

const LIST_FIELDS = [
  'UF_CRM_LEAD_TYPE',
  'UF_CRM_REGION',
  'UF_CRM_EXHIBITION',
  'UF_CRM_PRODUCT_INTEREST',
  'UF_CRM_PRIORITY',
];

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async processSession(bundle: SessionBundle): Promise<PipelineResult> {
    const { db, graph, bitrix } = this.deps;
    const allMessageIds = bundle.items.map((i) => i.messageId);

    // ── Idempotency gate (S10.4): drop already-processed messages ──
    const seen = db.alreadyProcessed(allMessageIds);
    const freshItems = bundle.items.filter((i) => !seen.has(i.messageId));
    if (freshItems.length === 0) {
      return { sessionId: bundle.sessionId, status: 'noop', leads: [], replyText: null, error: null };
    }

    db.upsertSession(bundle, 'received');

    try {
      // ── Attachment resolution (ASR / OCR) ──
      const resolved = await this.resolveAttachments(freshItems);

      // ── Segmentation (S6 Tier 2) ──
      const segResult = await this.deps.llm.segment({
        items: resolved.map((i) => ({
          messageId: i.messageId,
          timestamp: i.timestamp,
          type: i.type,
          ...(i.text !== undefined ? { text: i.text } : {}),
          ...(i.transcript !== undefined ? { transcript: i.transcript } : {}),
          ...(i.ocrText !== undefined ? { ocrText: i.ocrText } : {}),
        })),
      });
      db.setSessionStatus(bundle.sessionId, 'segmented');

      const byId = new Map(resolved.map((i) => [i.messageId, i]));
      const listValues = await this.loadListValues();
      const campaign: Campaign = {
        exhibition: this.deps.config.campaignExhibition,
        source: this.deps.config.campaignSource,
      };

      // ── Per-segment extraction -> gating -> mapping -> LeadWrite ──
      const writes: LeadWrite[] = [];
      const leadLocalIds: string[] = [];

      for (const seg of segResult.segments) {
        const segItems = seg.messageIds
          .map((id) => byId.get(id))
          .filter((x): x is SessionItem => !!x)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        if (segItems.length === 0) continue;

        const segmentText = assembleSegmentText(segItems);
        const cardText = assembleCardText(segItems);
        const needsAttachmentRetry = segItems.some(
          (i) => i.type === 'image' && (i.attachmentPending === true || i.ocrText == null),
        );

        const raw = await this.deps.llm.extract({ segmentText, cardText });
        const gated = applyGate(raw, { confidenceThreshold: this.deps.config.confidenceThreshold }, `${segmentText}\n${cardText ?? ''}`);

        // Non-lead filter (S6): skip segments without a name/phone/email/substance.
        if (!isLead({ name: gated.name, phones: gated.phones, emails: gated.emails, productInterestRaw: gated.productInterestRaw, priorityRaw: gated.priorityRaw })) {
          continue;
        }

        const { listFields, warnings: mapWarnings } = buildListFields(gated, campaign, listValues);
        const owner = resolveOwner(db, bundle.author.email, this.deps.config.bitrixDefaultOwnerId);

        const warnings = [...gated.warnings, ...mapWarnings];
        if (owner.warning) warnings.push(owner.warning);
        if (needsAttachmentRetry) warnings.push('attachment not yet available; flagged for retry');

        const localId = `${bundle.sessionId}#${seg.segmentId}`;
        const title = buildTitle(gated.name, gated.company);

        // Persist lead through the state machine before writing to CRM (S5).
        db.insertLead({
          id: localId,
          sessionId: bundle.sessionId,
          title,
          status: 'mapped',
          fieldsJson: JSON.stringify({ gated, listFields }),
          verbatim: gated.verbatim,
          aiSummaryRu: gated.summaryRu,
          warningsJson: JSON.stringify(warnings),
          needsAttachmentRetry,
        });

        writes.push({
          localId,
          sessionId: bundle.sessionId,
          title,
          assignedById: owner.ownerId,
          name: gated.name,
          company: gated.company,
          position: gated.position,
          country: gated.country,
          phones: gated.phones.map((p) => ({ value: p.value, type: p.type })),
          emails: gated.emails.map((e) => ({ value: e.value, type: e.type })),
          listFields,
          verbatim: gated.verbatim,
          aiSummaryRu: gated.summaryRu,
          service: {
            teamsGroupId: bundle.channel.teamsGroupId,
            teamsMessageIds: segItems.map((i) => i.messageId),
            teamsAuthor: bundle.author.email,
          },
          warnings,
          needsAttachmentRetry,
        });
        leadLocalIds.push(localId);
      }

      db.setSessionStatus(bundle.sessionId, 'extracted');

      // ── No real leads: mark processed, stay silent-ish (noop-like) ──
      if (writes.length === 0) {
        db.markProcessed(freshItems.map((i) => i.messageId), bundle.sessionId);
        db.setSessionStatus(bundle.sessionId, 'done');
        return { sessionId: bundle.sessionId, status: 'noop', leads: [], replyText: null, error: null };
      }

      for (const id of leadLocalIds) db.setLeadStatus(id, 'dedup_checked');
      for (const id of leadLocalIds) db.setLeadStatus(id, 'writing_crm');

      // ── Bitrix write (dedup + add/update inside client) ──
      const results = await bitrix.writeLeads(writes);

      const leadResults: PipelineLeadResult[] = [];
      let anyFailure = false;
      for (const r of results) {
        const write = writes.find((w) => w.localId === r.localId)!;
        if (r.bitrixLeadId != null && r.error == null) {
          db.setLeadBitrixId(r.localId, r.bitrixLeadId);
          db.setLeadStatus(r.localId, 'done');
        } else {
          db.setLeadStatus(r.localId, 'failed');
          anyFailure = true;
        }
        leadResults.push({
          localId: r.localId,
          bitrixLeadId: r.bitrixLeadId,
          title: write.title,
          warnings: write.warnings,
        });
      }

      // ── Idempotency ledger: record only after handling (S10.4) ──
      db.markProcessed(freshItems.map((i) => i.messageId), bundle.sessionId);
      db.setSessionStatus(bundle.sessionId, anyFailure ? 'failed' : 'done');

      const status = anyFailure ? 'partial' : 'ok';
      const replyText = buildReply(leadResults, bitrix, status);

      // ── Reply to manager (S11) ──
      await graph.postReply(bundle.channel, null, replyText);

      return { sessionId: bundle.sessionId, status, leads: leadResults, replyText, error: null };
    } catch (err) {
      db.setSessionStatus(bundle.sessionId, 'failed');
      const message = err instanceof Error ? err.message : String(err);
      const replyText = 'Не удалось обработать сообщение — оно помечено для повторной отправки.';
      await graph.postReply(bundle.channel, null, replyText).catch(() => {});
      return { sessionId: bundle.sessionId, status: 'error', leads: [], replyText, error: message };
    }
  }

  private async resolveAttachments(items: SessionItem[]): Promise<SessionItem[]> {
    const out: SessionItem[] = [];
    for (const item of items) {
      if (item.type === 'voice' && !item.transcript) {
        const transcript = await this.deps.asr.transcribe({
          ...(item.mediaUrl !== undefined ? { mediaUrl: item.mediaUrl } : {}),
        });
        out.push({ ...item, transcript });
      } else if (item.type === 'image' && item.ocrText == null && item.attachmentPending !== true) {
        const ocrText = await this.deps.ocr.readCard({
          ...(item.mediaUrl !== undefined ? { mediaUrl: item.mediaUrl } : {}),
          ocrText: item.ocrText ?? null,
        });
        out.push({ ...item, ocrText });
      } else {
        out.push(item);
      }
    }
    return out;
  }

  private async loadListValues(): Promise<ListValuesByField> {
    const out: ListValuesByField = {};
    for (const field of LIST_FIELDS) {
      const values = await this.deps.bitrix.listUserFieldValues(field);
      out[field] = values;
      this.deps.db.cacheListValues(field, values);
    }
    return out;
  }
}

// ── helpers ──────────────────────────────────────────────────

function assembleSegmentText(items: SessionItem[]): string {
  return items
    .map((i) => [i.text, i.transcript].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function assembleCardText(items: SessionItem[]): string | null {
  const cards = items.filter((i) => i.type === 'image' && i.ocrText).map((i) => i.ocrText!);
  return cards.length ? cards.join('\n') : null;
}

function buildTitle(name: string | null, company: string | null): string {
  if (name && company) return `${name} — ${company}`;
  if (name) return name;
  if (company) return company;
  return 'Лид с выставки';
}

function buildReply(
  leads: PipelineLeadResult[],
  bitrix: BitrixClient,
  status: 'ok' | 'partial',
): string {
  const created = leads.filter((l) => l.bitrixLeadId != null);
  const links = created.map((l) => bitrix.leadUrl(l.bitrixLeadId!)).join(' , ');
  if (status === 'ok') {
    const n = created.length;
    const noun = n === 1 ? 'лид создан' : 'лида/лидов создано';
    return `Готово: ${n} ${noun} — ${links}`;
  }
  // partial
  const failed = leads.filter((l) => l.bitrixLeadId == null).length;
  return `Частично обработано: создано ${created.length}, не удалось ${failed}. Ссылки: ${links || '—'}`;
}
