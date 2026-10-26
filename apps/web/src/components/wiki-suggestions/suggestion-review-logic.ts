import type { SuggestionStatus } from "#/components/desk/desk-logic.ts";

export const STALE_NOTE =
  "The page changed since the agent wrote this. The diff compares the proposal with the page as it is now, so accepting an edited body replaces the current text.";

export interface ReviewDiff {
  after: string;
  before: string;
  note: string | null;
}

/**
 * What a reviewer diffs against the proposal. A pending suggestion still
 * matches the base it was written against. A stale one diffs against the
 * page as it is now, so an edited accept cannot drop newer edits silently.
 */
export const reviewDiff = ({
  baseText,
  currentText,
  proposedText,
  status,
}: {
  baseText: string;
  currentText: string;
  proposedText: string;
  status: SuggestionStatus;
}): ReviewDiff =>
  status === "stale"
    ? { after: proposedText, before: currentText, note: STALE_NOTE }
    : { after: proposedText, before: baseText, note: null };
