/**
 * Grouping / segmentation contract (PRD Section 6, Tier 2).
 *
 * The full buffered batch (chronological) is handed to the LLM, which must
 * return an explicit assignment of every messageId to one of 1..N segments.
 * Each segment is extracted independently and becomes its own lead (or is
 * filtered out as a non-lead).
 */

export interface Segment {
  /** Stable local id within the session, e.g. `seg-1`. */
  segmentId: string;
  /** messageIds assigned to this segment, in chronological order. */
  messageIds: string[];
  /** Optional short reason the model grouped/split here (for traceability). */
  rationale?: string;
}

export interface SegmentationResult {
  segments: Segment[];
}
