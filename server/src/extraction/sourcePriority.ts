/**
 * Source-priority conflict resolution (PRD Section 8): card (read via vision) >
 * manager's explicit typed text > voice transcript.
 *
 * The single extraction call is prompted to prefer the card, but we do NOT trust
 * that blindly. When the business card carries a structured `Name:` value, this
 * enforces it in code for the name field — the PRD's canonical example
 * ("Aleksandr Ivanovich Petrov" on the card vs "Sasha Petrov" by voice) — and
 * logs the discrepancy as a warning rather than silently picking one.
 */

/** Extract a structured `Name:`-style value from card OCR text, if present. */
export function parseCardName(cardText: string | null): string | null {
  if (!cardText) return null;
  for (const line of cardText.split(/\r?\n/)) {
    const m = line.match(/^\s*(name|имя|фио)\s*:\s*(.+?)\s*$/i);
    if (m && m[2]!.trim()) return m[2]!.trim();
  }
  return null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface NameReconciliation {
  name: string | null;
  warning: string | null;
}

/**
 * Reconcile the extracted name against the card. If the card has a name and it
 * differs from the extracted value, the CARD wins and a warning is recorded.
 */
export function reconcileName(extractedName: string | null, cardText: string | null): NameReconciliation {
  const cardName = parseCardName(cardText);
  if (!cardName) return { name: extractedName, warning: null };

  if (!extractedName) {
    // Card has a name the extractor dropped — trust the card, note it.
    return { name: cardName, warning: 'name taken from business card (source priority: card > text > voice)' };
  }

  const a = norm(extractedName);
  const b = norm(cardName);
  if (a === b || a.includes(b) || b.includes(a)) {
    return { name: extractedName, warning: null };
  }
  // Genuine conflict: card wins, discrepancy surfaced (never hidden).
  return {
    name: cardName,
    warning: `name conflict resolved by source priority (card="${cardName}" over other-source="${extractedName}")`,
  };
}
