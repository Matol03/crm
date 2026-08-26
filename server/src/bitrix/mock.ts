/**
 * In-memory mock Bitrix client (PRD Section 10, mock mode).
 *
 * Satisfies the full BitrixClient interface with deterministic lead IDs so the
 * whole pipeline runs with zero external dependency. Models the behaviors the
 * pipeline depends on: live userfield values, duplicate-by-comm lookup scoped
 * by owner, and add-vs-update on same-owner duplicates (Section 10.4).
 */

import type {
  BitrixClient,
  BitrixLeadRecord,
  DuplicateMatch,
  LeadWrite,
  LeadWriteResult,
} from '../contracts/bitrix.js';

/** Seed userfield values from the PRD (Section 9) — mock/dev only. */
export const SEED_USERFIELD_VALUES: Record<string, Array<{ label: string; id: number }>> = {
  UF_CRM_LEAD_TYPE: [
    { label: 'Partner', id: 45 },
    { label: 'Customer', id: 47 },
  ],
  // Labels verified live against the portal via crm.lead.userfield.list.
  UF_CRM_REGION: [
    { label: 'Europe', id: 49 },
    { label: 'CIS', id: 51 },
    { label: 'MENA', id: 53 },
    { label: 'APAC', id: 55 },
    { label: 'North America', id: 57 },
    { label: 'LATAM', id: 59 },
    { label: 'Africa', id: 61 },
  ],
  UF_CRM_PRODUCT_INTEREST: [
    { label: 'Platform / Core', id: 71 },
    { label: 'Analytics', id: 73 },
    { label: 'Integration Services', id: 75 },
    { label: 'Support & SLA', id: 77 },
    { label: 'Training', id: 79 },
    { label: 'OEM / White label', id: 81 },
  ],
  UF_CRM_PRIORITY: [
    { label: 'High', id: 83 },
    { label: 'Medium', id: 85 },
    { label: 'Low', id: 87 },
  ],
};

interface StoredLead {
  id: number;
  fields: Record<string, unknown>;
  ownerId: number;
  teamsAuthor: string;
  phones: string[];
  emails: string[];
  timelineComments: string[];
}

export interface MockBitrixOptions {
  /** Base portal URL for building card links (no secret). */
  portalBaseUrl?: string;
  /** Starting id for deterministic allocation. */
  firstLeadId?: number;
}

export class MockBitrixClient implements BitrixClient {
  private readonly leads = new Map<number, StoredLead>();
  private nextId: number;
  private readonly portalBaseUrl: string;
  /** Count of add/update calls, for batching-math sanity checks in tests. */
  batchCallCount = 0;

  constructor(opts: MockBitrixOptions = {}) {
    this.nextId = opts.firstLeadId ?? 4821;
    this.portalBaseUrl = opts.portalBaseUrl ?? 'https://mock.bitrix24.local';
  }

  async listUserFieldValues(fieldCode: string): Promise<Array<{ label: string; id: number }>> {
    return SEED_USERFIELD_VALUES[fieldCode] ?? [];
  }

  async findDuplicate(comm: { phones: string[]; emails: string[] }): Promise<DuplicateMatch | null> {
    for (const lead of this.leads.values()) {
      const phoneHit = comm.phones.some((p) => lead.phones.includes(p));
      const emailHit = comm.emails.some((e) => lead.emails.includes(e.toLowerCase()));
      if (phoneHit || emailHit) {
        return { bitrixLeadId: lead.id, ownerId: lead.ownerId, teamsAuthor: lead.teamsAuthor };
      }
    }
    return null;
  }

  async writeLeads(leads: LeadWrite[]): Promise<LeadWriteResult[]> {
    this.batchCallCount++;
    const results: LeadWriteResult[] = [];
    for (const lead of leads) {
      const phones = lead.phones.map((p) => p.value);
      const emails = lead.emails.map((e) => e.value.toLowerCase());

      // Content-based dedup: same-author duplicate -> update, else create.
      // Keyed on Teams author (real manager identity), so two managers on the
      // same visitor never merge even when both fall back to the default owner.
      const dup = await this.findDuplicate({ phones, emails });
      if (dup && dup.teamsAuthor === lead.service.teamsAuthor) {
        const existing = this.leads.get(dup.bitrixLeadId)!;
        existing.fields = { ...existing.fields, ...this.toFields(lead) };
        existing.timelineComments.push(lead.aiSummaryRu);
        results.push({
          localId: lead.localId,
          bitrixLeadId: dup.bitrixLeadId,
          updatedExisting: true,
          error: null,
        });
        continue;
      }

      const id = this.nextId++;
      this.leads.set(id, {
        id,
        fields: this.toFields(lead),
        ownerId: lead.assignedById,
        teamsAuthor: lead.service.teamsAuthor,
        phones,
        emails,
        timelineComments: [lead.aiSummaryRu],
      });
      results.push({ localId: lead.localId, bitrixLeadId: id, updatedExisting: false, error: null });
    }
    return results;
  }

  async getLead(id: number): Promise<BitrixLeadRecord | null> {
    const lead = this.leads.get(id);
    return lead ? { id, fields: lead.fields } : null;
  }

  leadUrl(id: number): string {
    return `${this.portalBaseUrl}/crm/lead/details/${id}/`;
  }

  /** Optional in the contract; tests override it to model a title search. */
  findServiceLeadsByTitle?: (title: string) => Promise<number[]>;

  async deleteLead(id: number): Promise<void> {
    if (!this.leads.delete(id)) throw new Error(`lead ${id} not found`);
  }

  async setLeadStatus(id: number, statusId: string): Promise<void> {
    const lead = this.leads.get(id);
    if (!lead) throw new Error(`lead ${id} not found`);
    lead.fields['STATUS_ID'] = statusId;
  }

  /** Test helper: all stored leads. */
  allLeads(): StoredLead[] {
    return [...this.leads.values()];
  }

  private toFields(lead: LeadWrite): Record<string, unknown> {
    return {
      TITLE: lead.title,
      ASSIGNED_BY_ID: lead.assignedById,
      NAME: lead.name,
      COMPANY_TITLE: lead.company,
      POST: lead.position,
      // Multi-value comm fields Bitrix-style.
      PHONE: lead.phones.map((p) => ({ VALUE: p.value, VALUE_TYPE: p.type })),
      EMAIL: lead.emails.map((e) => ({ VALUE: e.value, VALUE_TYPE: e.type })),
      COMMENTS: lead.verbatim,
      UF_CRM_LEAD_TYPE: lead.listFields.leadTypeId,
      UF_CRM_REGION: lead.listFields.regionId ?? null,
      UF_CRM_PRODUCT_INTEREST: lead.listFields.productInterestId ?? null,
      UF_CRM_PRIORITY: lead.listFields.priorityId ?? null,
      UF_CRM_TEAMS_GROUP_ID: lead.service.teamsGroupId,
      UF_CRM_TEAMS_MESSAGE_IDS: lead.service.teamsMessageIds.join(','),
      UF_CRM_TEAMS_AUTHOR: lead.service.teamsAuthor,
    };
  }
}
