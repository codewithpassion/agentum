// Pure helpers behind the thread composer (V2.12): turn what the composer
// sends into a `runs.start` input, and decide what the thread lets a person do.

import type { AppendMessage } from "@assistant-ui/react";
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
  inbox: "This thread belongs to an inbox conversation. Reply in the inbox.",
  mcp: "An MCP client started this thread. Reply from that client.",
  routine: "A routine started this thread, so it has no reply here.",
  slack: "This thread belongs to a Slack conversation. Reply there.",
  trigger: "A trigger started this thread, so it has no reply here.",
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
  return REPLY_NOTES[origin] ?? "This thread is read only here.";
};

/** The id of the last user message, or null when the thread has none. */
export const latestUserMessage = (
  messages: readonly Pick<ThreadMessage, "id" | "role">[]
): string | null =>
  messages.findLast((message) => message.role === "user")?.id ?? null;

/** Whether a thread status means the agent is still working or waiting on a person. */
export const isActiveStatus = (status: ThreadStatus): boolean =>
  status === "running" || status === "waiting";
