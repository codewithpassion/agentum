// The logic behind the answer card (V1.14): what a request looks like in the
// chat, how its expiry and its settled line read, and the payload an answer
// sends. Pure: the session stream keeps the requests, `request-card.tsx` draws them.

import {
  A2A_SEND_TOOL,
  type AnswerSurface,
  type ApprovalDecision,
  MAIL_SEND_TOOL,
} from "@repo/db/shared";
import {
  type ApprovalAnswer,
  type ApprovalDisplay,
  approvalDisplaySchema,
  type Question,
  type QuestionAnswer,
  type QuestionDisplay,
  questionDisplaySchema,
  type TakeoverAnswer,
  type TakeoverDisplay,
  takeoverDisplaySchema,
} from "@repo/protocol/requests";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** How a request ended, as far as the chat knows. `conflict` means someone else answered first. */
export type Settled =
  | {
      answer: ApprovalAnswer | QuestionAnswer | TakeoverAnswer;
      /** The Clerk user id of whoever answered. */
      answeredBy: string | null;
      /** Set when a held mail failed to send after the answer allowed it. */
      sendError?: string;
      status: "answered";
      via: AnswerSurface | null;
    }
  | { status: "cancelled" }
  | { status: "conflict" }
  | { status: "expired" };

interface RequestBase {
  /** The id of the transcript entry the card sits after, or null for the end. */
  anchorId: string | null;
  expiresAt: string;
  id: string;
  runId: string;
  /** Null while the request waits for an answer. */
  settled: Settled | null;
}

/** A request the chat shows, pending or settled. */
export type RequestView =
  | (RequestBase & { display: ApprovalDisplay; kind: "approval" })
  | (RequestBase & { display: QuestionDisplay; kind: "question" })
  | (RequestBase & { display: TakeoverDisplay; kind: "takeover" });

/** What the answer mutation takes, without the request id. */
export type AnswerPayload = ApprovalAnswer | QuestionAnswer;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** "expires in 42 min", or "expired" once the time has passed. */
export const expiryText = (expiresAt: string, nowMs: number): string => {
  const left = Date.parse(expiresAt) - nowMs;
  if (Number.isNaN(left) || left <= 0) {
    return "expired";
  }
  const minutes = Math.ceil(left / MS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `expires in ${minutes} min`;
  }
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  return `expires in ${hours} h`;
};

const DECISION_TEXT: Record<ApprovalDecision, string> = {
  allow_once: "Allowed once",
  always_allow: "Always allowed",
  deny: "Denied",
};

const SURFACE_TEXT: Record<AnswerSurface, string> = {
  a2a: "an outside agent",
  slack: "Slack",
  web: "the web app",
};

/**
 * The line a settled card shows, such as "Allowed once by Dom in Slack".
 * `by` is the answerer's name, or null when it is not known.
 */
export const settledLine = (
  kind: RequestView["kind"],
  settled: Settled,
  by: string | null
): string => {
  switch (settled.status) {
    case "expired":
      return "Expired, nobody answered";
    case "cancelled":
      return "Withdrawn, the run ended";
    case "conflict":
      return "Already answered somewhere else";
    default: {
      const { answer, via } = settled;
      const who = by === null ? "" : ` by ${by}`;
      const where = via === null ? "" : ` in ${SURFACE_TEXT[via]}`;
      if ("decision" in answer) {
        if (
          settled.sendError &&
          (answer.decision === "allow_once" ||
            answer.decision === "always_allow")
        ) {
          return `${DECISION_TEXT[answer.decision]}${who}${where}, but sending failed: ${settled.sendError}`;
        }
        const note =
          answer.decision === "deny" && answer.note ? `: ${answer.note}` : "";
        return `${DECISION_TEXT[answer.decision]}${who}${where}${note}`;
      }
      return `${kind === "question" ? "Answered" : "Handled"}${who}${where}`;
    }
  }
};

const MAIL_PREVIEW_LINES = 6;

/** The fields a held outgoing mail shows in its approval card. */
export interface MailApprovalFields {
  body: string;
  cc: string[];
  from: string;
  subject: string;
  to: string[];
}

const addressList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;

/**
 * The mail fields of a `mail_send` approval, or null when the display is not a
 * mail approval or its input does not have the shape a held mail has.
 * `body` is the first lines of the preview. An absent `cc` reads as none.
 */
export const mailApprovalFields = (
  display: ApprovalDisplay
): MailApprovalFields | null => {
  if (display.toolName !== MAIL_SEND_TOOL || !isRecord(display.input)) {
    return null;
  }
  const { cc, from, preview, subject, to } = display.input;
  const toList = addressList(to);
  const ccList = cc === undefined ? [] : addressList(cc);
  if (
    typeof from !== "string" ||
    typeof subject !== "string" ||
    typeof preview !== "string" ||
    toList === null ||
    ccList === null
  ) {
    return null;
  }
  return {
    body: preview.split("\n").slice(0, MAIL_PREVIEW_LINES).join("\n"),
    cc: ccList,
    from,
    subject,
    to: toList,
  };
};

/** What an outgoing message to an outside agent shows in its approval card. */
export interface A2aSendFields {
  host: string;
  peer: string;
  text: string;
}

/**
 * The fields of an `a2a_send` approval, or null when the display is not one or
 * its input lacks them. `text` is the whole message, as it will be sent.
 */
export const a2aSendFields = (
  display: ApprovalDisplay
): A2aSendFields | null => {
  if (display.toolName !== A2A_SEND_TOOL || !isRecord(display.input)) {
    return null;
  }
  const { host, peer, text } = display.input;
  if (
    typeof host !== "string" ||
    typeof peer !== "string" ||
    typeof text !== "string"
  ) {
    return null;
  }
  return { host, peer, text };
};

/**
 * True when the card offers "Always allow". The rule it saves applies to member
 * runs, and a peer-rooted run is gated by its connection's tool policy and not
 * by that rule alone, so a peer's run does not offer it. An outgoing message to
 * an outside agent is always asked, so it does not either.
 */
export const offersAlwaysAllow = (display: ApprovalDisplay): boolean =>
  display.peerRun !== true && a2aSendFields(display) === null;

/** The answer to an approval. A blank note is left out. */
export const approvalAnswer = (
  decision: ApprovalDecision,
  note: string
): ApprovalAnswer => {
  const trimmed = note.trim();
  return trimmed === "" || decision !== "deny"
    ? { decision }
    : { decision, note: trimmed };
};

/** What a person picked and typed for each question, by question text. */
export interface QuestionInputs {
  choices: Readonly<Record<string, readonly string[]>>;
  text: Readonly<Record<string, string>>;
}

const answerText = (question: Question, inputs: QuestionInputs): string => {
  const picked = (question.choices ?? []).filter((choice) =>
    (inputs.choices[question.question] ?? []).includes(choice)
  );
  const typed = (inputs.text[question.question] ?? "").trim();
  return [...picked, ...(typed === "" ? [] : [typed])].join(", ");
};

/** True when every question has a picked choice or typed text. */
export const canSubmitAnswers = (
  questions: readonly Question[],
  inputs: QuestionInputs
): boolean =>
  questions.length > 0 &&
  questions.every((question) => answerText(question, inputs) !== "");

/** The answer to a question request: picked choices and free text joined with ", ". */
export const questionAnswer = (
  questions: readonly Question[],
  inputs: QuestionInputs
): QuestionAnswer => ({
  answers: Object.fromEntries(
    questions.map((question) => [
      question.question,
      answerText(question, inputs),
    ])
  ),
});

/** The choices after one is toggled. A single-choice question holds at most one. */
export const toggledChoices = (
  question: Question,
  current: readonly string[],
  choice: string
): string[] => {
  if (current.includes(choice)) {
    return current.filter((item) => item !== choice);
  }
  return question.multiSelect === true ? [...current, choice] : [choice];
};

/** The request a `request.opened` event describes, or null when the payload is not one. */
export const viewFromOpened = (
  payload: Record<string, unknown>,
  runId: string | null,
  anchorId: string | null
): RequestView | null => {
  const id = textOf(payload.requestId);
  const expiresAt = textOf(payload.expiresAt);
  if (id === null || expiresAt === null || runId === null) {
    return null;
  }
  const base = { anchorId, expiresAt, id, runId, settled: null };
  if (payload.kind === "approval") {
    const display = approvalDisplaySchema.safeParse(payload.display);
    return display.success
      ? { ...base, display: display.data, kind: "approval" }
      : null;
  }
  if (payload.kind === "takeover") {
    const display = takeoverDisplaySchema.safeParse(payload.display);
    return display.success
      ? { ...base, display: display.data, kind: "takeover" }
      : null;
  }
  if (payload.kind === "question") {
    const display = questionDisplaySchema.safeParse(payload.display);
    return display.success
      ? { ...base, display: display.data, kind: "question" }
      : null;
  }
  return null;
};

/** A pending request from `requests.pending`. */
export const viewFromRecord = (
  record: {
    display: ApprovalDisplay | QuestionDisplay | TakeoverDisplay;
    expiresAt: string;
    id: string;
    kind: "approval" | "question" | "takeover";
    runId: string;
  },
  anchorId: string | null
): RequestView | null =>
  viewFromOpened(
    {
      display: record.display,
      expiresAt: record.expiresAt,
      kind: record.kind,
      requestId: record.id,
    },
    record.runId,
    anchorId
  );

/** The outcome a `request.answered`, `request.expired` or `request.cancelled` event records. */
export const settledFromEvent = (
  type: string,
  payload: Record<string, unknown>
): Settled | null => {
  if (type === "request.expired") {
    return { status: "expired" };
  }
  if (type === "request.cancelled") {
    return { status: "cancelled" };
  }
  if (type !== "request.answered") {
    return null;
  }
  const via =
    payload.via === "slack" || payload.via === "web" ? payload.via : null;
  const answeredBy = textOf(payload.answeredBy);
  if (
    payload.decision === "allow_once" ||
    payload.decision === "always_allow" ||
    payload.decision === "deny"
  ) {
    const note = textOf(payload.note);
    return {
      answer:
        note === null
          ? { decision: payload.decision }
          : { decision: payload.decision, note },
      answeredBy,
      status: "answered",
      via,
    };
  }
  if (payload.kind === "takeover") {
    const note = textOf(payload.note);
    return {
      answer: note === null ? {} : { note },
      answeredBy,
      status: "answered",
      via,
    };
  }
  if (isRecord(payload.answers)) {
    const answers = Object.fromEntries(
      Object.entries(payload.answers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    return { answer: { answers }, answeredBy, status: "answered", via };
  }
  return null;
};

/** The settled outcome with a failed send noted on an answered one. Any other outcome, or no error, is returned as it is. */
export const withSendError = (
  settled: Settled | null,
  error: string | null
): Settled | null =>
  settled?.status === "answered" && error !== null && error !== ""
    ? { ...settled, sendError: error }
    : settled;

/** True when a tRPC error says the request was answered already. */
export const isConflict = (cause: unknown): boolean =>
  isRecord(cause) && isRecord(cause.data) && cause.data.code === "CONFLICT";

/** A typed answer and a picked answer are mutually exclusive. */
export const pickQuestion = (
  inputs: QuestionInputs,
  question: Question,
  choice: string
): QuestionInputs => ({
  choices: {
    ...inputs.choices,
    [question.question]: toggledChoices(
      question,
      inputs.choices[question.question] ?? [],
      choice
    ),
  },
  text: { ...inputs.text, [question.question]: "" },
});
export const typeQuestion = (
  inputs: QuestionInputs,
  question: string,
  text: string
): QuestionInputs => ({
  choices: { ...inputs.choices, [question]: [] },
  text: { ...inputs.text, [question]: text },
});

/** Task conversation wording, with timestamps from the stored closing event. */
export function taskSettlement(
  kind: RequestView["kind"],
  settled: Settled,
  at: string | undefined,
  edited: boolean,
  fallback: string
): string {
  if (settled.status === "cancelled" && edited) {
    return "Cancelled, you edited the message";
  }
  if (kind === "takeover" && settled.status === "answered") {
    return `Handed back${at ? ` at ${at.slice(11, 16)}` : ""}`;
  }
  return `${fallback}${at && settled.status === "answered" ? ` at ${at.slice(11, 16)}` : ""}`;
}
