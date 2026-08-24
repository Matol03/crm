/**
 * Prompt templates for the DeepSeek LLM client (PRD Sections 6, 8).
 *
 * Prompts steer the model, but they are never the sole guardrail — code-side
 * gating (extraction/gating.ts) re-checks confidence, formats, and the
 * Partner/Customer double-check regardless of what the model returns.
 */

import type { SessionItem } from '../contracts/session.js';

type SegItem = Pick<SessionItem, 'messageId' | 'timestamp' | 'type' | 'text' | 'transcript' | 'ocrText'>;

export const SEGMENTATION_SYSTEM = `You segment a chronological batch of trade-show messages from ONE sales manager into distinct business contacts (leads).
A single contact may span several messages (a card photo, a voice note, a text clarification). Different contacts must go in different segments.
Strong boundary signals: a new business-card photo with no language tying it to the previous contact; explicit separators ("second contact", "one more", "следующий"); a full change of name/company with no transition.
Return STRICT JSON only, no prose, matching:
{"segments":[{"segmentId":"seg-1","messageIds":["..."],"rationale":"short"}]}
Every input messageId MUST appear in exactly one segment. Preserve chronological order within a segment.`;

export function segmentationUser(items: SegItem[]): string {
  const lines = items.map((i) => ({
    messageId: i.messageId,
    timestamp: i.timestamp,
    type: i.type,
    text: i.text ?? null,
    transcript: i.transcript ?? null,
    cardText: i.ocrText ?? null,
  }));
  return `Messages (chronological):\n${JSON.stringify(lines, null, 2)}\n\nReturn the segmentation JSON.`;
}

export const EXTRACTION_SYSTEM = `You extract ONE trade-show lead from the provided text + business-card text + voice transcript.
Rules:
- Values must be verbatim as written/spoken, NOT normalized or invented.
- When the business card and the voice disagree (e.g. a name), prefer the CARD text; note nothing yourself — code handles conflicts.
- Provide a per-field confidence in [0,1]. Use LOW confidence when unsure; never guess to fill a field.
- leadTypeRaw is "partner" ONLY if there is explicit reseller/distributor/partner language; otherwise "customer" or "unclear".
- summaryRu is a concise Russian summary that INCLUDES the manager's evaluative judgments ("promising, but no budget until next year").
- verbatim is the untouched text + transcript concatenated in chronological order.
Return STRICT JSON only, matching this shape (nulls allowed for missing scalars):
{"name":null,"company":null,"position":null,"country":null,
 "phones":[{"value":"+...","type":"MOBILE|WORK|OTHER"}],
 "emails":[{"value":"a@b.c","type":"WORK|PERSONAL|OTHER"}],
 "productInterestRaw":null,"priorityRaw":null,"leadTypeRaw":"customer|partner|unclear",
 "confidence":{"name":0,"company":0,"position":0,"country":0,"phones":0,"emails":0,"productInterest":0,"priority":0,"leadType":0},
 "evidence":{"name":"<short exact quote you read the name from>","company":"...","position":"...","country":"...","phone":"...","email":"...","productInterest":"...","priority":"..."},
 "summaryRu":"...","verbatim":"..."}
For "evidence", quote the source text EXACTLY as it appears (a few words is enough). Omit a field from "evidence" if you inferred it rather than reading it.`;

export function extractionUser(segmentText: string, cardText: string | null): string {
  return `BUSINESS CARD TEXT (may be empty):\n${cardText ?? '(none)'}\n\nMESSAGE TEXT + VOICE TRANSCRIPT (chronological):\n${segmentText || '(none)'}\n\nReturn the extraction JSON.`;
}
