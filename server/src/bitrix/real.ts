/**
 * Real Bitrix24 REST client (PRD Section 10).
 *
 * - Every call goes through one global token-bucket rate limiter (S10.3).
 * - Writes are batched (add/update lead + timeline comment per lead), chunked to
 *   stay under 50 sub-calls per `batch` request.
 * - Retryable throttling errors (QUERY_LIMIT_EXCEEDED / OPERATION_TIME_LIMIT,
 *   HTTP 503/429) are retried with exponential backoff at the granularity of the
 *   failing lead's sub-calls, not the whole batch (S10.3).
 * - Content dedup: same-owner duplicate -> update; different owner -> new lead
 *   (S10.4). The webhook credential lives only in the transport, never logged.
 */

import type {
  BitrixClient,
  BitrixLeadRecord,
  DuplicateMatch,
  LeadWrite,
  LeadWriteResult,
} from '../contracts/bitrix.js';
import type { RateLimiter } from './rateLimiter.js';
import type { BitrixTransport, BitrixEnvelope } from './transport.js';
import { portalOrigin } from './transport.js';
import { encodeCmd } from './query.js';

export interface RealBitrixOptions {
  webhookUrl: string;
  rateLimiter: RateLimiter;
  transport: BitrixTransport;
  batchSize?: number;
  maxRetries?: number;
  /** Base backoff in ms (doubled per attempt). */
  backoffBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Decision {
  action: 'add' | 'update';
  existingId?: number;
}

const RETRYABLE = /QUERY_LIMIT_EXCEEDED|OPERATION_TIME_LIMIT|rate limit|too many requests/i;

export class RealBitrixClient implements BitrixClient {
  private readonly origin: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RealBitrixOptions) {
    this.origin = portalOrigin(opts.webhookUrl);
    this.batchSize = opts.batchSize ?? 13;
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  leadUrl(id: number): string {
    return `${this.origin}/crm/lead/details/${id}/`;
  }

  // ── low-level call with rate limiting + backoff ──────────────

  private isRetryable(status: number, env: BitrixEnvelope): boolean {
    if (status === 503 || status === 429) return true;
    const msg = `${env.error ?? ''} ${env.error_description ?? ''}`;
    return RETRYABLE.test(msg);
  }

  private async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<BitrixEnvelope<T>> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { status, body } = await this.opts.rateLimiter.run(() => this.opts.transport(method, params));
      if (status >= 200 && status < 300 && !body.error) return body as BitrixEnvelope<T>;
      if (this.isRetryable(status, body) && attempt < this.maxRetries) {
        await this.sleep(this.backoffBaseMs * 2 ** attempt);
        attempt++;
        continue;
      }
      // Non-retryable, or out of retries: surface the error to the caller.
      throw new BitrixCallError(method, status, body.error ?? `HTTP ${status}`, body.error_description);
    }
  }

  // ── reads ────────────────────────────────────────────────────

  async listUserFieldValues(fieldCode: string): Promise<Array<{ label: string; id: number }>> {
    const env = await this.call<Array<Record<string, unknown>>>('crm.lead.userfield.list', {
      filter: { FIELD_NAME: fieldCode },
    });
    const field = (env.result ?? [])[0];
    const list = (field?.LIST as Array<{ ID: string | number; VALUE: string }> | undefined) ?? [];
    return list.map((v) => ({ label: v.VALUE, id: Number(v.ID) }));
  }

  async findDuplicate(comm: { phones: string[]; emails: string[] }): Promise<DuplicateMatch | null> {
    const leadId =
      (await this.findByComm('EMAIL', comm.emails)) ?? (await this.findByComm('PHONE', comm.phones));
    if (leadId == null) return null;
    const lead = await this.getLead(leadId);
    const ownerId = lead ? Number(lead.fields.ASSIGNED_BY_ID) : 0;
    return { bitrixLeadId: leadId, ownerId };
  }

  private async findByComm(type: 'EMAIL' | 'PHONE', values: string[]): Promise<number | null> {
    if (!values.length) return null;
    const env = await this.call<{ LEAD?: Array<string | number> }>('crm.duplicate.findbycomm', {
      entity_type: 'LEAD',
      type,
      values,
    });
    const ids = env.result?.LEAD ?? [];
    return ids.length ? Number(ids[0]) : null;
  }

  async getLead(id: number): Promise<BitrixLeadRecord | null> {
    const env = await this.call<Record<string, unknown> | null>('crm.lead.get', { id });
    if (!env.result) return null;
    return { id, fields: env.result };
  }

  // ── writes (batched) ─────────────────────────────────────────

  async writeLeads(leads: LeadWrite[]): Promise<LeadWriteResult[]> {
    const decisions = new Map<string, Decision>();
    for (const lead of leads) {
      const dup = await this.findDuplicate({
        phones: lead.phones.map((p) => p.value),
        emails: lead.emails.map((e) => e.value),
      });
      if (dup && dup.ownerId === lead.assignedById) {
        decisions.set(lead.localId, { action: 'update', existingId: dup.bitrixLeadId });
      } else {
        decisions.set(lead.localId, { action: 'add' });
      }
    }

    const results: LeadWriteResult[] = [];
    for (let i = 0; i < leads.length; i += this.batchSize) {
      const chunk = leads.slice(i, i + this.batchSize);
      const chunkResults = await this.writeChunk(chunk, decisions, 0);
      results.push(...chunkResults);
    }
    return results;
  }

  /** Write one chunk; retry only the failing leads' sub-calls on throttling. */
  private async writeChunk(
    chunk: LeadWrite[],
    decisions: Map<string, Decision>,
    attempt: number,
  ): Promise<LeadWriteResult[]> {
    const cmd: Record<string, string> = {};
    chunk.forEach((lead, idx) => {
      const d = decisions.get(lead.localId)!;
      const leadKey = `lead_${idx}`;
      if (d.action === 'update') {
        cmd[leadKey] = encodeCmd('crm.lead.update', { id: d.existingId, fields: this.toFields(lead) });
      } else {
        cmd[leadKey] = encodeCmd('crm.lead.add', {
          fields: this.toFields(lead),
          params: { REGISTER_SONET_EVENT: 'N' },
        });
      }
      // Timeline comment for the AI summary (never overwrites COMMENTS, S8).
      const entityId = d.action === 'update' ? String(d.existingId) : `$result[${leadKey}]`;
      cmd[`comment_${idx}`] = encodeCmd('crm.timeline.comment.add', {
        fields: { ENTITY_ID: entityId, ENTITY_TYPE: 'lead', COMMENT: lead.aiSummaryRu },
      });
    });

    let env: BitrixEnvelope<{ result?: Record<string, unknown>; result_error?: Record<string, unknown> }>;
    try {
      env = await this.call('batch', { halt: 0, cmd });
    } catch (e) {
      // Whole-batch transport failure already exhausted call-level retries.
      const message = e instanceof Error ? e.message : String(e);
      return chunk.map((lead) => ({ localId: lead.localId, bitrixLeadId: null, updatedExisting: false, error: message }));
    }

    const perResult = (env.result?.result ?? {}) as Record<string, unknown>;
    const perError = (env.result?.result_error ?? {}) as Record<string, { error?: string; error_description?: string } | string>;

    const failedRetryable: LeadWrite[] = [];
    const out: LeadWriteResult[] = [];
    chunk.forEach((lead, idx) => {
      const leadKey = `lead_${idx}`;
      const err = perError[leadKey];
      if (err) {
        const msg = typeof err === 'string' ? err : `${err.error ?? ''} ${err.error_description ?? ''}`;
        if (RETRYABLE.test(msg) && attempt < this.maxRetries) {
          failedRetryable.push(lead);
          return;
        }
        out.push({ localId: lead.localId, bitrixLeadId: null, updatedExisting: false, error: msg.trim() || 'sub-call failed' });
        return;
      }
      const d = decisions.get(lead.localId)!;
      const id = d.action === 'update' ? d.existingId! : Number(perResult[leadKey]);
      out.push({
        localId: lead.localId,
        bitrixLeadId: Number.isFinite(id) ? id : null,
        updatedExisting: d.action === 'update',
        error: Number.isFinite(id) ? null : 'no id returned',
      });
    });

    if (failedRetryable.length) {
      await this.sleep(this.backoffBaseMs * 2 ** attempt);
      const retried = await this.writeChunk(failedRetryable, decisions, attempt + 1);
      out.push(...retried);
    }
    return out;
  }

  /** Bitrix field object; omit null/empty so updates never blank a field. */
  private toFields(lead: LeadWrite): Record<string, unknown> {
    const f: Record<string, unknown> = {
      TITLE: lead.title,
      ASSIGNED_BY_ID: lead.assignedById,
      COMMENTS: lead.verbatim,
      UF_CRM_LEAD_TYPE: lead.listFields.leadTypeId,
      UF_CRM_TEAMS_GROUP_ID: lead.service.teamsGroupId,
      UF_CRM_TEAMS_MESSAGE_IDS: lead.service.teamsMessageIds.join(','),
      UF_CRM_TEAMS_AUTHOR: lead.service.teamsAuthor,
    };
    if (lead.name) f.NAME = lead.name;
    if (lead.company) f.COMPANY_TITLE = lead.company;
    if (lead.position) f.POST = lead.position;
    if (lead.phones.length) f.PHONE = lead.phones.map((p) => ({ VALUE: p.value, VALUE_TYPE: p.type }));
    if (lead.emails.length) f.EMAIL = lead.emails.map((e) => ({ VALUE: e.value, VALUE_TYPE: e.type }));
    if (lead.listFields.regionId != null) f.UF_CRM_REGION = lead.listFields.regionId;
    if (lead.listFields.exhibitionId != null) f.UF_CRM_EXHIBITION = lead.listFields.exhibitionId;
    if (lead.listFields.productInterestId != null) f.UF_CRM_PRODUCT_INTEREST = lead.listFields.productInterestId;
    if (lead.listFields.priorityId != null) f.UF_CRM_PRIORITY = lead.listFields.priorityId;
    return f;
  }
}

export class BitrixCallError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    message: string,
    readonly description?: string,
  ) {
    super(`Bitrix ${method} failed (${status}): ${message}`);
    this.name = 'BitrixCallError';
  }
}
