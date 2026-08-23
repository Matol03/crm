/**
 * Bitrix write contract (PRD Sections 9, 10).
 *
 * The pipeline produces `LeadWrite` records; the Bitrix client (mock or real)
 * turns them into `crm.lead.add` / batch calls, plus a separate
 * `crm.timeline.comment.add` for the AI summary (never overwriting COMMENTS).
 */

/** Bitrix list-field IDs resolved by the mapping layer (PRD Section 9). */
export interface LeadListFields {
  /** UF_CRM_LEAD_TYPE — never empty; Partner=45 / Customer=47 (seed). */
  leadTypeId: number;
  regionId?: number;
  exhibitionId?: number;
  productInterestId?: number;
  priorityId?: number;
}

export interface LeadWrite {
  /** Local id for cross-referencing before the Bitrix id exists. */
  localId: string;
  sessionId: string;
  title: string;
  /** ASSIGNED_BY_ID — resolved from message author (PRD Section 10.5). */
  assignedById: number;
  name: string | null;
  company: string | null;
  position: string | null;
  country: string | null;
  phones: Array<{ value: string; type: string }>;
  emails: Array<{ value: string; type: string }>;
  listFields: LeadListFields;
  /** COMMENTS — verbatim text + transcript, never replaced. */
  verbatim: string;
  /** Written separately via crm.timeline.comment.add. */
  aiSummaryRu: string;
  /** Service-only traceability fields (PRD Section 9). */
  service: {
    teamsGroupId: string;
    teamsMessageIds: string[];
    teamsAuthor: string;
  };
  warnings: string[];
  needsAttachmentRetry: boolean;
}

export interface BitrixLeadRecord {
  id: number;
  fields: Record<string, unknown>;
}

/** Result of a write attempt for one local lead. */
export interface LeadWriteResult {
  localId: string;
  bitrixLeadId: number | null;
  /** True when an existing same-owner duplicate was updated instead of added. */
  updatedExisting: boolean;
  error: string | null;
}

/** Duplicate lookup by phone/email (PRD Section 10.4). */
export interface DuplicateMatch {
  bitrixLeadId: number;
  ownerId: number;
  /**
   * The matched lead's Teams author. Dedup keys on this (the real manager
   * identity), not the resolved owner: two unmapped managers both fall back to
   * the default owner, and keying on owner would wrongly merge their two
   * legitimate leads on the same visitor (S10.4 intent).
   */
  teamsAuthor?: string | null;
}

export interface BitrixClient {
  /** Live list values for a userfield (PRD Section 9). */
  listUserFieldValues(fieldCode: string): Promise<Array<{ label: string; id: number }>>;
  /** crm.duplicate.findbycomm by phone/email. */
  findDuplicate(comm: { phones: string[]; emails: string[] }): Promise<DuplicateMatch | null>;
  /** Write a batch of leads (add or update), respecting rate limits. */
  writeLeads(leads: LeadWrite[]): Promise<LeadWriteResult[]>;
  /** Fetch a lead (for the read-only view / verification). */
  getLead(id: number): Promise<BitrixLeadRecord | null>;
  /** Base portal URL for building card links in the reply (no secret leaked). */
  leadUrl(id: number): string;
}
