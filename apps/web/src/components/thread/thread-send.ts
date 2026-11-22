// Pure helpers behind the thread composer (V2.12): turn what the composer
// sends into a `runs.start` input, and decide what the thread lets a person do.

import type { AppendMessage } from "@assistant-ui/react";
import type { AgentRuntime } from "@repo/db/shared";
import type { ThreadMessage, ThreadStatus } from "@repo/protocol/thread";

/** The text of a composer message: its text parts, joined and trimmed. */
export const textOfAppend = (message: Pick<AppendMessage, "content">): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

/** The server file ids of a composer message's attachments, in order, once each. */
export const fileIdsOfAppend = (
  message: Pick<AppendMessage, "attachments">
): string[] => {
  const ids = new Set<string>();
  for (const attachment of message.attachments ?? []) {
    for (const part of attachment.content) {
      if (part.type === "file") {
        ids.add(part.data);
      }
    }
  }
  return [...ids];
};

/** The body the browser sends to `runs.start`. */
export interface StartRunBody {
  agentId: string;
  input: { fileIds: string[]; text: string };
  requestId: string;
  session: { externalKey: string; origin: "ui" };
}

export const startRunBody = (input: {
  agentId: string;
  fileIds: string[];
  requestId: string;
  session: { externalKey: string | null; id: string };
  text: string;
}): StartRunBody => ({
  agentId: input.agentId,
  input: { fileIds: input.fileIds, text: input.text },
  requestId: input.requestId,
  session: {
    externalKey: input.session.externalKey ?? input.session.id,
    origin: "ui",
  },
});

const REPLY_NOTES: Record<string, string> = {
  inbox: "This conversation came from the inbox. Reply in the inbox.",
  mcp: "An MCP client started this conversation. Reply from that client.",
  routine: "A routine started this conversation, so it has no reply here.",
  slack: "This conversation came from Slack. Reply there.",
  trigger: "A trigger started this conversation, so it has no reply here.",
};

/** The body the browser sends to `runs.reply` in a sub-thread: the session by id, never a key. */
export const replyBody = (input: {
  fileIds: string[];
  requestId: string;
  sessionId: string;
  text: string;
}) => ({
  input: { fileIds: input.fileIds, text: input.text },
  requestId: input.requestId,
  sessionId: input.sessionId,
});

/**
 * Why a thread started elsewhere is read only here, or null for a thread the UI
 * started or one an agent's hand-off started (a sub-thread), which replies here.
 */
export const replyNote = (origin: string, subThread = false): string | null => {
  if (origin === "ui" || subThread) {
    return null;
  }
  return REPLY_NOTES[origin] ?? "This conversation is read only here.";
};

/** The body the browser sends to `runs.sendWhileWorking`: a message for a task that is working. */
export const sendWhileWorkingBody = (input: {
  fileIds: string[];
  requestId: string;
  runId: string;
  text: string;
}) => ({
  input: { fileIds: input.fileIds, text: input.text },
  requestId: input.requestId,
  runId: input.runId,
});

/** What the box says while a task works: the Cloud runtime reads a message at once, every other one gets it when the step ends. */
export const busyNote = (runtime: AgentRuntime): string =>
  runtime === "cloud"
    ? "The agent reads this as it works."
    : "The agent gets this when the current step ends.";

/** The id of the last user message a person can edit, or null. A message sent into a working task is not the start of one. */
export const latestUserMessage = (
  messages: readonly Pick<ThreadMessage, "id" | "role" | "steered">[]
): string | null =>
  messages.findLast(
    (message) => message.role === "user" && message.steered !== true
  )?.id ?? null;

/** Whether a thread status means the agent is still working or waiting on a person. */
export const isActiveStatus = (status: ThreadStatus): boolean =>
  status === "running" || status === "waiting";
