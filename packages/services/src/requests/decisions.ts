import {
  decisionsAnswerSchema,
  decisionsDisplaySchema,
} from "@repo/protocol/requests";
import type { RequestRow } from "./records.ts";

/** The tool name a decision queue is stored under. */
export const DECISIONS_TOOL = "ask_decisions";
export const DECISIONS_TOOL_USE_PREFIX = "decisions:";

/**
 * A decision queue outlives its run and no runtime waits on it: `ask_decisions`
 * returns at once, and the answers come back as a follow-up run. Its tool use
 * id is `decisions:<ulid>`.
 */
export const isDecisionsRequest = (row: {
  toolName: string;
  toolUseId: string;
}): boolean =>
  row.toolName === DECISIONS_TOOL &&
  row.toolUseId.startsWith(DECISIONS_TOOL_USE_PREFIX);

/** Under the longest input a run takes, so a long answer is cut and never refused. Each line is masked before the cut. */
const WAKE_TEXT_MAX = 90_000;
const NO_ANSWER = "no answer";
const WHITESPACE = /\s+/g;

const oneLine = (text: string): string =>
  text.replaceAll(WHITESPACE, " ").trim();

/**
 * The input of the follow-up run that carries a closed decision queue back to
 * its agent: a fixed line, then one line per question in the order it was
 * asked, `<question>: <answer>`. A question nobody answered says so, which is
 * how an expired queue reads.
 */
export const decisionsWakeText = (
  row: RequestRow,
  mask: (text: string) => string = (text) => text
): string => {
  const { questions } = decisionsDisplaySchema.parse(JSON.parse(row.display));
  const { decisions } = row.answer
    ? decisionsAnswerSchema.parse(JSON.parse(row.answer))
    : { decisions: {} as Record<string, string> };
  const intro =
    row.status === "expired"
      ? "The decisions you raised have expired. Continue the task from where you stopped, and treat the unanswered ones as open."
      : "The decisions you raised have all been answered. Continue the task from where you stopped.";
  return [
    intro,
    ...questions.map(
      ({ id, text }) =>
        `${oneLine(text)}: ${oneLine(decisions[id] ?? NO_ANSWER)}`
    ),
  ]
    .map(mask)
    .join("\n")
    .slice(0, WAKE_TEXT_MAX);
};
