/**
 * Teams author -> Bitrix owner resolution (PRD Section 10.5).
 *
 * ASSIGNED_BY_ID must equal the Bitrix user for the message author ("whoever
 * brought in the contact owns the lead"). On no mapping, fall back to a
 * configured default owner AND attach a warning — never silently assign to an
 * arbitrary/admin account.
 */

import type { Db } from '../db/index.js';

export interface OwnerResolution {
  ownerId: number;
  warning: string | null;
}

export function resolveOwner(
  db: Db,
  authorEmail: string,
  defaultOwnerId: number,
): OwnerResolution {
  const mapped = db.getBitrixUserId(authorEmail);
  if (mapped != null) {
    return { ownerId: mapped, warning: null };
  }
  return {
    ownerId: defaultOwnerId,
    warning: `no employee mapping for author; assigned to default owner ${defaultOwnerId} — needs manual mapping`,
  };
}
