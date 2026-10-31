// Maps the protocol's thread messages (V2.12) to assistant-ui's ThreadMessageLike.
// Pure: it reads its input and returns new objects.

import type { ThreadMessageLike } from "@assistant-ui/react";
import { speakerEnvelopeSchema } from "@repo/protocol/live";
import type {
  ThreadMessage,
  ThreadPart,
  ThreadStatus,
} from "@repo/protocol/thread";
import { fileIdPart } from "./attachment-adapter.ts";

type Content = Exclude<ThreadMessageLike["content"], string>[number];
type Status = NonNullable<ThreadMessageLike["status"]>;
type Attachment = NonNullable<ThreadMessageLike["attachments"]>[number];
type ToolArgs = NonNullable<Extract<Content, { type: "tool-call" }>["args"]>;
type ToolCallPart = Extract<ThreadPart, { type: "tool-call" }>;

const PLACEHOLDER_TEXT = "(content too large to show)";
const DEFAULT_TOOL_NAME = "tool";

const STATUS_OF: Record<ThreadStatus, Status> = {
  cancelled: { reason: "cancelled", type: "incomplete" },
  done: { reason: "stop", type: "complete" },
  failed: { reason: "error", type: "incomplete" },
  running: { type: "running" },
  waiting: { reason: "interrupt", type: "requires-action" },
};

/** The assistant-ui status of a message, as a new object each call. */
export const messageStatusOf = (status: ThreadStatus): Status => ({
  ...STATUS_OF[status],
});

// Tool input comes from stored JSON events, so an object here is JSON-shaped.
const isToolArgs = (value: unknown): value is ToolArgs =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toolCallOf = (part: ToolCallPart): Content => {
  const { input } = part;
  const argsText =
    isToolArgs(input) || input === null || input === undefined
      ? {}
      : { argsText: JSON.stringify(input) };
  return {
    args: isToolArgs(input) ? { ...input } : {},
    ...argsText,
    isError: part.ok === false,
    // No result yet: leave it undefined so the call shows as running.
    result: part.ok === null ? undefined : (part.result ?? ""),
    toolCallId: part.toolUseId,
    toolName: part.name ?? DEFAULT_TOOL_NAME,
    type: "tool-call",
  };
};

const assistantContent = (part: ThreadPart): Content[] => {
  if (part.type === "tool-call") {
    return [toolCallOf(part)];
  }
  if (part.type === "request") {
    return [{ data: { requestId: part.requestId }, type: "data-request" }];
  }
  if (part.type === "placeholder") {
    return [{ text: PLACEHOLDER_TEXT, type: "text" }];
  }
  if (part.type === "attachment") {
    return [
      {
        data: "fileId" in part ? { fileId: part.fileId } : { path: part.path },
        type: "data-attachment",
      },
    ];
  }
  if (part.type === "artifact") {
    const { artifactId, kind, title, version, versionId } = part;
    return [
      {
        data: { artifactId, kind, title, version, versionId },
        type: "data-artifact",
      },
    ];
  }
  return [{ text: part.text, type: part.type }];
};

/**
 * A peer's turn is stored inside the speaker envelope the agent reads. A person
 * reads what the peer wrote. Text that is not a whole envelope stays as it is.
 */
export const peerText = (text: string): string => {
  try {
    const parsed = speakerEnvelopeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.harbourmaster_turn.text : text;
  } catch {
    return text;
  }
};

// A user message's content holds text only. Files go to its attachments.
const userContent = (part: ThreadPart, fromPeer: boolean): Content[] => {
  if (part.type === "text") {
    return [{ text: fromPeer ? peerText(part.text) : part.text, type: "text" }];
  }
  if (part.type === "placeholder") {
    return [{ text: PLACEHOLDER_TEXT, type: "text" }];
  }
  return [];
};

// The file part carries the id, so an edited message sends its files again.
const fileAttachment = (fileId: string): Attachment => ({
  content: [
    fileIdPart({ id: fileId, mime: "application/octet-stream", name: fileId }),
  ],
  id: fileId,
  name: fileId,
  status: { type: "complete" },
  type: "file",
});

/** Converts a protocol thread message to a new assistant-ui message. */
export const toThreadMessageLike = (
  message: ThreadMessage,
  authorLabel?: string
): ThreadMessageLike => {
  const base = {
    createdAt:
      message.createdAt === null ? undefined : new Date(message.createdAt),
    id: message.id,
    metadata: {
      custom: { runId: message.runId, ...(authorLabel ? { authorLabel } : {}) },
    },
    role: message.role,
  };
  if (message.role === "assistant") {
    return {
      ...base,
      content: message.parts.flatMap(assistantContent),
      status: messageStatusOf(message.status),
    };
  }
  const attachments = message.parts.flatMap((part) =>
    part.type === "attachment" && "fileId" in part
      ? [fileAttachment(part.fileId)]
      : []
  );
  return {
    ...base,
    ...(attachments.length === 0 ? {} : { attachments }),
    content: message.parts.flatMap((part) =>
      userContent(part, message.actor?.kind === "peer")
    ),
  };
};
