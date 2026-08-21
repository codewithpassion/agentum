import type { Question } from "./api";
import { formatRelativeTime } from "./format";
import { formatUntil } from "./schedule-format";

/**
 * What a question card shows, decided away from the component so the rules can
 * be read (and tested) in one place.
 *
 * The card is *controlled*: its state comes from the question view, whoever
 * wrote it - the first broadcast, the answer response, a Slack click arriving
 * on the socket. The only thing the component adds is whether a request of its
 * own is in flight, which is why `busy` is the one input that is not the
 * question.
 *
 * Expiry is never derived here. A deadline that has passed still reads pending
 * until the server says otherwise, because the server is what wakes the agent -
 * a card that expired itself would disagree with the thread under it.
 */

export type QuestionCardMode = "answered" | "expired" | "pending";

export interface QuestionCardState {
  /** True while an answer is in flight, or once the question is resolved. */
  disabled: boolean;
  /** "expires in 12m", or null when the question has no deadline (or is over). */
  expiryLabel: string | null;
  /** True when the answer is typed rather than chosen. */
  freeText: boolean;
  mode: QuestionCardMode;
  /** Sterner styling and an "Approve"/"Deny" reading of the options. */
  permission: boolean;
  /** "Answered by Ada (via Slack) · 3m ago", or null while pending. */
  resolutionLabel: string | null;
}

/** Slack ids as they arrive when the name cache was cold: `U01AB2CD3EF`. */
const RAW_SLACK_ID = /^[UW][A-Z0-9]{4,}$/;

const PERMISSION_APPROVALS = new Set(["approve", "allow", "yes"]);
const PERMISSION_DENIALS = new Set(["deny", "decline", "no", "reject"]);

/**
 * How an option button should read. Only permission requests get the loaded
 * colours - a plain question's options are choices, not verdicts, and painting
 * one green would be the card taking a side.
 */
export const optionTone = (
  question: Question,
  option: string
): "danger" | "neutral" | "primary" => {
  if (question.kind !== "permission") {
    return "neutral";
  }
  const normalised = option.trim().toLowerCase();
  if (PERMISSION_APPROVALS.has(normalised)) {
    return "primary";
  }
  return PERMISSION_DENIALS.has(normalised) ? "danger" : "neutral";
};

/**
 * Who answered, in words. A Slack answerer whose name never made it into the
 * cache is a bare `U…` id, which means nothing on screen - so the surface
 * carries the sentence instead of the id.
 */
const answererLabel = (question: Question): string => {
  const answerer = question.answeredBy;
  const name = answerer === null ? "" : answerer.name.trim();
  const viaSlack = question.answeredVia === "slack";
  if (name === "" || RAW_SLACK_ID.test(name)) {
    return viaSlack ? "someone on Slack" : "someone else";
  }
  return viaSlack ? `${name} (via Slack)` : name;
};

const resolutionLabelOf = (question: Question, now: number): string | null => {
  if (question.status === "expired") {
    return "Expired — nobody answered in time";
  }
  if (question.status !== "answered") {
    return null;
  }
  const when =
    question.answeredAt === null
      ? ""
      : ` · ${formatRelativeTime(question.answeredAt, now)}`;
  return `Answered by ${answererLabel(question)}${when}`;
};

const expiryLabelOf = (question: Question, now: number): string | null => {
  if (question.status !== "pending" || question.expiresAt === null) {
    return null;
  }
  return `expires ${formatUntil(question.expiresAt, now)}`;
};

export const questionCardState = (
  question: Question,
  { busy = false, now = Date.now() }: { busy?: boolean; now?: number } = {}
): QuestionCardState => {
  const mode: QuestionCardMode = question.status;
  return {
    disabled: busy || mode !== "pending",
    expiryLabel: expiryLabelOf(question, now),
    freeText: question.options === null,
    mode,
    permission: question.kind === "permission",
    resolutionLabel: resolutionLabelOf(question, now),
  };
};

/**
 * The question a badge click should open: the oldest one still waiting, since
 * that is the one that has been holding an agent up the longest.
 */
export const oldestPending = (
  questions: readonly Question[]
): Question | null =>
  questions
    .filter((question) => question.status === "pending")
    .reduce<Question | null>(
      (oldest, question) =>
        oldest === null || question.createdAt < oldest.createdAt
          ? question
          : oldest,
      null
    );
