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
  error:
    "bg-red-50 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100 dark:border-red-900",
  ok: "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-900",
  running:
    "bg-blue-50 text-blue-900 border-blue-200 dark:bg-blue-950 dark:text-blue-100 dark:border-blue-900",
  waiting:
    "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900",
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
