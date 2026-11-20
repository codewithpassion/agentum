import type {
  LearnLevel,
  MemoryChange,
  MemoryChangeAction,
} from "@repo/db/shared";

export const LEARNED_DAYS = 7;

const DAY_MS = 86_400_000;

const ACTION_SENTENCES: Record<MemoryChangeAction, string> = {
  add: "Remembered",
  edit: "Changed a note to",
  forget: "Forgot",
  merge: "Merged notes into",
};

/** ISO string (toISOString) of the moment LEARNED_DAYS days before nowMs. */
export function weekStartIso(nowMs: number): string {
  return new Date(nowMs - LEARNED_DAYS * DAY_MS).toISOString();
}

function createdMs(change: MemoryChange): number {
  return Date.parse(change.createdAt);
}

/** Changes for Learned this week: status "applied", createdAt at or after weekStartIso(nowMs), newest first (ties by id descending). When learnLevel is "quiet", changes written by "agent" or "dream" are left out, because Quietly shows those only in the dream diary; a person's own changes stay. Never mutates. */
export function learnedThisWeek(
  changes: readonly MemoryChange[],
  nowMs: number,
  learnLevel: LearnLevel
): MemoryChange[] {
  const windowStartMs = Date.parse(weekStartIso(nowMs));
  const hideAutomatic = learnLevel === "quiet";
  return changes
    .filter((change) => {
      if (change.status !== "applied") {
        return false;
      }
      if (createdMs(change) < windowStartMs) {
        return false;
      }
      return !(hideAutomatic && change.writtenBy !== "person");
    })
    .sort((a, b) => {
      const byTime = createdMs(b) - createdMs(a);
      if (byTime !== 0) {
        return byTime;
      }
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? 1 : -1;
    });
}

/** add "Remembered", edit "Changed a note to", forget "Forgot", merge "Merged notes into", followed by ": " and the text. */
export function changeSentence(
  change: Pick<MemoryChange, "action" | "text">
): string {
  return `${ACTION_SENTENCES[change.action]}: ${change.text}`;
}

/** "today" when createdAt is on the same UTC day as nowMs, "yesterday" for the day before, otherwise "N days ago". */
export function changeWhen(createdAt: string, nowMs: number): string {
  const days =
    Math.floor(nowMs / DAY_MS) - Math.floor(Date.parse(createdAt) / DAY_MS);
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "yesterday";
  }
  return `${days} days ago`;
}
