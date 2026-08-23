/**
 * Assemble Bitrix list-field IDs for a lead from gated extraction + campaign
 * constants (PRD Section 9). Every unmapped value leaves its field blank and
 * records a warning; UF_CRM_LEAD_TYPE is the one field that is never empty.
 */

import type { GatedExtraction } from '../contracts/extraction.js';
import type { LeadListFields } from '../contracts/bitrix.js';
import { mapToListId, type ListValue } from './index.js';

export interface Campaign {
  exhibition: string;
  source: string;
}

export type ListValuesByField = Record<string, ListValue[]>;

export interface BuiltListFields {
  listFields: LeadListFields;
  warnings: string[];
}

export function buildListFields(
  gated: GatedExtraction,
  campaign: Campaign,
  values: ListValuesByField,
  fuzzyThreshold = 0.82,
): BuiltListFields {
  const warnings: string[] = [];

  // UF_CRM_LEAD_TYPE — never empty. Default handled upstream (always customer/partner).
  const leadTypeLabel = gated.leadType === 'partner' ? 'Partner' : 'Customer';
  const leadTypeMatch = mapToListId(
    'UF_CRM_LEAD_TYPE',
    leadTypeLabel,
    values.UF_CRM_LEAD_TYPE ?? [],
    fuzzyThreshold,
  );
  // Guaranteed present in seed; if a portal somehow lacks it, fall back to Customer id if known.
  const leadTypeId =
    leadTypeMatch.id ??
    (values.UF_CRM_LEAD_TYPE ?? []).find((v) => v.label === 'Customer')?.id ??
    47;

  const listFields: LeadListFields = { leadTypeId };

  const region = mapToListId('UF_CRM_REGION', gated.country, values.UF_CRM_REGION ?? [], fuzzyThreshold);
  if (region.id != null) listFields.regionId = region.id;
  else if (gated.country) warnings.push(`region for "${gated.country}" not in reference list, left blank`);

  const exhibition = mapToListId(
    'UF_CRM_EXHIBITION',
    campaign.exhibition,
    values.UF_CRM_EXHIBITION ?? [],
    fuzzyThreshold,
  );
  if (exhibition.id != null) listFields.exhibitionId = exhibition.id;
  else if (campaign.exhibition) warnings.push(`exhibition "${campaign.exhibition}" not in reference list, left blank`);

  const interest = mapToListId(
    'UF_CRM_PRODUCT_INTEREST',
    gated.productInterestRaw,
    values.UF_CRM_PRODUCT_INTEREST ?? [],
    fuzzyThreshold,
  );
  if (interest.id != null) listFields.productInterestId = interest.id;
  else if (gated.productInterestRaw)
    warnings.push(`product interest "${gated.productInterestRaw}" not in reference list, left blank`);

  const priority = mapToListId('UF_CRM_PRIORITY', gated.priorityRaw, values.UF_CRM_PRIORITY ?? [], fuzzyThreshold);
  if (priority.id != null) listFields.priorityId = priority.id;
  else if (gated.priorityRaw)
    warnings.push(`priority "${gated.priorityRaw}" not in reference list, left blank`);

  return { listFields, warnings };
}
