import type { BandTone, DeskCard, DeskLane } from "@repo/db/shared";

/** The ISO string of the browser's local midnight on the day of `now`. */
export const localMidnightIso = (now: Date): string =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

export type CardLink =
  | { kind: "task"; runId: string }
  | { kind: "thread"; threadId: string }
  | null;

/** A thread card opens its thread. Other cards with a run open the task. Proposals link nowhere. */
export const cardLink = (
  card: Pick<DeskCard, "kind" | "runId" | "threadId">
): CardLink => {
  if (card.threadId) {
    return { kind: "thread", threadId: card.threadId };
  }
  if (card.kind !== "thread" && card.runId) {
    return { kind: "task", runId: card.runId };
  }
  return null;
};

const BAND_CLASSES: Record<BandTone, string> = {
  error: "bg-destructive/10 text-destructive border-destructive/30",
  ok: "bg-success/10 text-success border-success/30",
  running: "bg-info/10 text-info border-info/30",
  waiting: "bg-warning/10 text-warning border-warning/30",
};

/** The Tailwind classes for a status band of the given tone. */
export const bandClass = (tone: BandTone): string => BAND_CLASSES[tone];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago `at` was, from `nowMs`. Future or unparsable times read as "just now". */
export const elapsedText = (at: string, nowMs: number): string => {
  const diff = nowMs - Date.parse(at);
  if (Number.isNaN(diff) || diff < MINUTE_MS) {
    return "just now";
  }
  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)} min ago`;
  }
  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)} h ago`;
  }
  return `${Math.floor(diff / DAY_MS)} d ago`;
};

export const cardSubtitle = (
  input: { agentName: string; at: string; startedBy: string },
  nowMs: number
): string =>
  `${input.agentName} · started by ${input.startedBy} · ${elapsedText(input.at, nowMs)}`;

const LANE_LABELS: Record<DeskLane, string> = {
  done: "Done today",
  needs_you: "Needs you",
  running: "Running",
};

export const laneLabel = (lane: DeskLane): string => LANE_LABELS[lane];

export type SuggestionStatus = "pending" | "stale";

/** The one sentence under a suggested-edit card. A stale one says the page moved on. */
export const suggestionStatusText = (
  status: SuggestionStatus,
  summary: string
): string =>
  status === "stale"
    ? "The page changed since this was suggested, so edit it first to accept."
    : summary;

/** The one sentence under a library conflict card. */
export const conflictStatusText = (path: string): string =>
  `${path} changed in the library and in the agent's copy, so choose which to keep.`;
