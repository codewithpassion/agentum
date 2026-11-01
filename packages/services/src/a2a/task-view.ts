/**
 * The A2A shape of a task row, and the words a task's status carries. Pure
 * string and object work, no database.
 */
import { HOPS_METADATA_KEY } from "@repo/a2a/extensions";
import type { Message, Part } from "@repo/a2a/messages";
import type { Task } from "@repo/a2a/tasks";
import type { a2aTasks } from "@repo/db/schema/a2a";
import type { A2aTaskState } from "@repo/db/shared";
import { A2aTaskError } from "./errors.ts";

export type TaskRow = typeof a2aTasks.$inferSelect;

/** States a task never leaves. */
export const TERMINAL: readonly A2aTaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];

/** States with a run that has not ended. */
export const RUNNING: readonly A2aTaskState[] = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
];

/** What a task says about itself in each state, in plain words. Never an internal error. */
export const STATUS_TEXT = {
  approvalWaiting:
    "Waiting for a person on the receiving side to approve this message. Nothing has been delivered to the agent yet. The answer will not come back in this call: ask again with GetTask, or send a new message in this context later.",
  cancelled: "The run was cancelled.",
  cancelledByPeer: "The sender cancelled this message.",
  connectionRevoked: "The connection was revoked.",
  declined: "A person declined this message.",
  failed: "The run failed.",
  finishedEmpty: "The agent finished and had no text to send back.",
  interrupted: "The run was interrupted before it finished.",
  notStarted: "The message could not be started.",
  queued: "The agent has this message and will start shortly.",
  unanswered:
    "Nobody answered the agent's question in time, so the task was ended. Send a new message to start another.",
  working: "The agent is working on this message.",
} as const;

const QUESTION_PREFIX = "The agent asks: ";
const ANSWER_SUFFIX = " Answer by sending another message with this taskId.";
const QUESTION_MAX = 2000;

/** The status message of a task waiting on a question the run asked. */
export const questionStatusText = (
  questions: readonly { choices?: readonly string[]; question: string }[]
): string => {
  const asked = questions
    .map(({ choices, question }) =>
      choices && choices.length > 0
        ? `${question} (${choices.join(" / ")})`
        : question
    )
    .join(" ");
  const clipped =
    asked.length > QUESTION_MAX
      ? `${asked.slice(0, QUESTION_MAX - 1)}…`
      : asked;
  return `${QUESTION_PREFIX}${clipped}${ANSWER_SUFFIX}`;
};

const agentMessage = (row: TaskRow, text: string): Message => ({
  contextId: row.contextId,
  messageId: `${row.id}:${row.state}`,
  parts: [{ text }],
  role: "ROLE_AGENT",
  taskId: row.id,
});

const userMessage = (row: TaskRow): Message => ({
  contextId: row.contextId,
  messageId: row.messageId,
  parts: [{ text: row.inputText }],
  role: "ROLE_USER",
  taskId: row.id,
});

/**
 * The task as a client reads it. An unfinished task and a task that ended
 * without a result carry `status.message`, because Hermes reads that as the
 * reply and does not poll. `historyLength` follows spec section 3.2.4: unset
 * keeps all, 0 drops the history, N keeps the latest N.
 */
export const toTask = (row: TaskRow, historyLength?: number): Task => {
  const completed =
    row.state === "TASK_STATE_COMPLETED" &&
    row.resultText !== null &&
    row.resultText !== "";
  const message =
    row.state === "TASK_STATE_COMPLETED" && !completed
      ? STATUS_TEXT.finishedEmpty
      : row.statusText;
  const history: Message[] = [
    userMessage(row),
    ...(message !== null && !completed ? [agentMessage(row, message)] : []),
  ];
  const kept =
    historyLength === undefined
      ? history
      : history.slice(Math.max(history.length - historyLength, 0));
  return {
    ...(completed
      ? {
          artifacts: [
            {
              artifactId: `${row.id}-result`,
              name: "result",
              parts: [{ mediaType: "text/plain", text: row.resultText ?? "" }],
            },
          ],
        }
      : {}),
    contextId: row.contextId,
    ...(kept.length > 0 ? { history: kept } : {}),
    id: row.id,
    status: {
      ...(message !== null && !completed
        ? { message: agentMessage(row, message) }
        : {}),
      state: row.state,
      timestamp: row.updatedAt,
    },
  };
};

/** A text type (`text/plain` from Hermes, say) or a JSON type, parameters such as `charset` aside. */
const isTextOrJsonType = (mediaType: string): boolean => {
  const type = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json")
  );
};

/**
 * The text of a message's parts. A JSON data part becomes JSON text, and a text
 * part with a `mediaType` (Hermes sends `text/plain`) is text. A text or data
 * part whose `mediaType` is neither a text nor a JSON type is refused, and so
 * are files: a `raw` or `url` part is `ContentTypeNotSupportedError`.
 */
export const textOfParts = (parts: readonly Part[]): string => {
  const texts: string[] = [];
  for (const part of parts) {
    if (
      (part.text !== undefined || part.data !== undefined) &&
      part.mediaType !== undefined &&
      !isTextOrJsonType(part.mediaType)
    ) {
      throw new A2aTaskError(
        "ContentTypeNotSupportedError",
        "Only text and JSON parts are supported."
      );
    }
    if (part.text !== undefined) {
      texts.push(part.text);
    } else if (part.data === undefined) {
      throw new A2aTaskError(
        "ContentTypeNotSupportedError",
        "Only text and JSON parts are supported."
      );
    } else {
      texts.push(JSON.stringify(part.data));
    }
  }
  return texts.join("\n\n");
};

/** The hop count a message claims, or 0 when it claims none that makes sense. */
export const hopsOf = (
  ...metadata: readonly (Record<string, unknown> | undefined)[]
): number => {
  let hops = 0;
  for (const entry of metadata) {
    const claimed = entry?.[HOPS_METADATA_KEY];
    if (
      typeof claimed === "number" &&
      Number.isFinite(claimed) &&
      claimed > 0
    ) {
      hops = Math.max(hops, Math.floor(claimed));
    }
  }
  return hops;
};

/** The host of an origin, or null when there is none or it does not parse. */
export const hostOf = (origin: string | null): string | null => {
  if (origin === null) {
    return null;
  }
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};
