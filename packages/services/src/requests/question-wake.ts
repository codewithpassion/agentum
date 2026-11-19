import { outcomeText } from "@repo/protocol/requests";
import { outcomeOf, type RequestRow } from "./records.ts";

/** Under the longest input a run takes, so a long answer is cut and never refused. */
const WAKE_TEXT_MAX = 90_000;
const WITHDRAWN = "The question was withdrawn.";

/** What one closed question says to the agent. A person's withdrawal is not the run ending, so it gets its own line. */
const lineOf = (row: RequestRow): string => {
  const outcome = outcomeOf(row);
  if (!outcome || outcome.status === "cancelled") {
    return WITHDRAWN;
  }
  return outcomeText("question", outcome) ?? WITHDRAWN;
};

/**
 * The input of the run that carries a parked run's answers back to it: a fixed
 * line, then the answer to each question the run asked, in the order it asked.
 */
export const questionWakeText = (rows: readonly RequestRow[]): string =>
  [
    "The questions you asked have closed. Continue the task from where you stopped.",
    ...rows.map(lineOf),
  ]
    .join("\n")
    .slice(0, WAKE_TEXT_MAX);
