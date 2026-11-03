// Written from Agentum's event contract; no trueforge code is adapted.
import type { EventType, RequestStatus, RunStatus } from "@repo/db/shared";
import {
  type ArtifactThreadPart,
  artifactThreadPartSchema,
} from "@repo/protocol/artifacts";
import { extractAttachmentMarkers } from "@repo/protocol/attachments";
import {
  type ApprovalDisplay,
  approvalDisplaySchema,
  type QuestionDisplay,
  questionDisplaySchema,
} from "@repo/protocol/requests";
import type { EventFrame, StreamFrame } from "@repo/protocol/stream";

/** Server-resolved, browser-safe presentation; never copied from message payloads.
 * Adapters resolve name from the authenticated actor's user/guest display data.
 * Do not include email or other private profile fields.
 */
export interface ThreadActorDisplay {
  name: string;
}

type ThreadActor = EventFrame["actor"];
export type ThreadFrame = StreamFrame & {
  actorDisplay?: ThreadActorDisplay;
};

/** Structural input accepts stored event records without importing server modules. */
export interface ThreadEvent {
  actor?: ThreadActor;
  actorDisplay?: ThreadActorDisplay;
  createdAt: string;
  id: string;
  payload: Record<string, unknown>;
  payloadRef?: string | null;
  runId: string | null;
  type: EventType;
}

export type ThreadStatus =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";
export type RequestPart = {
  expiresAt: string;
  requestId: string;
  /** Closing event payload, including answer, answeredBy and via when supplied. */
  settlement?: Record<string, unknown>;
  status: RequestStatus;
  toolUseId: string | null;
  type: "request";
} & (
  | { display: ApprovalDisplay; kind: "approval" }
  | { display: QuestionDisplay; kind: "question" }
);
export type ThreadPart =
  | { type: "text" | "reasoning"; text: string }
  | {
      type: "tool-call";
      name: string | null;
      input: unknown;
      result: unknown;
      ok: boolean | null;
      toolUseId: string;
    }
  | { type: "attachment"; fileId: string }
  // Markers contain runtime paths, not file ids. Resolving them needs the UI's file lookup.
  | { type: "attachment"; path: string }
  | RequestPart
  | ArtifactThreadPart
  | { type: "placeholder"; eventId: string; eventType: EventType };

export interface ThreadMessage {
  actor?: ThreadActor;
  actorDisplay?: ThreadActorDisplay;
  /** Live-only frames have no timestamp; the first stored event fills it in. */
  createdAt: string | null;
  id: string;
  parts: ThreadPart[];
  role: "user" | "assistant";
  runId: string | null;
  status: ThreadStatus;
}

interface Cursor {
  finished?: string;
  open?: { key: string; start: number; count: number };
}
interface FoldState {
  cursors: Map<string, Cursor>;
  seen: Set<string>;
}
const stateKey = Symbol("thread fold state");
type FoldList = ThreadMessage[] & { [stateKey]?: FoldState };

// Metadata belongs to the returned value (no global cache). Keep that list when
// applying frames; serialising or spreading it intentionally starts a new fold.
const stateOf = (messages: ThreadMessage[]): FoldState =>
  (messages as FoldList)[stateKey] ?? { cursors: new Map(), seen: new Set() };
const attach = (
  messages: ThreadMessage[],
  state: FoldState
): ThreadMessage[] => {
  Object.defineProperty(messages, stateKey, { value: state });
  return messages;
};

const statusOf = (status: RunStatus): ThreadStatus => {
  // The neutral status vocabulary treats interrupted as failed and queued/offered as running.
  if (status === "interrupted") {
    return "failed";
  }
  return status === "queued" || status === "offered" ? "running" : status;
};
const eventStatus: Partial<Record<EventType, RunStatus>> = {
  "run.cancelled": "cancelled",
  "run.failed": "failed",
  "run.finished": "done",
  "run.interrupted": "interrupted",
  "run.queued": "queued",
  "run.resumed": "running",
  "run.started": "running",
  "run.waiting": "waiting",
};
const terminal = (status: ThreadStatus): boolean =>
  status === "done" || status === "failed" || status === "cancelled";
const textParts = (text: string): ThreadPart[] => {
  const extracted = extractAttachmentMarkers(text);
  return [
    ...(extracted.text === ""
      ? []
      : [{ text: extracted.text, type: "text" as const }]),
    ...extracted.paths.map((path) => ({ path, type: "attachment" as const })),
  ];
};

const requestPart = (payload: Record<string, unknown>): RequestPart | null => {
  if (
    typeof payload.requestId !== "string" ||
    typeof payload.expiresAt !== "string"
  ) {
    return null;
  }
  const base = {
    expiresAt: payload.expiresAt,
    requestId: payload.requestId,
    status: "pending" as const,
    toolUseId: typeof payload.toolUseId === "string" ? payload.toolUseId : null,
    type: "request" as const,
  };
  if (payload.kind === "approval") {
    const display = approvalDisplaySchema.safeParse(payload.display);
    return display.success
      ? { ...base, display: display.data, kind: "approval" }
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

const artifactPart = (
  payload: Record<string, unknown>
): ArtifactThreadPart | null => {
  const part = artifactThreadPartSchema.safeParse({
    artifactId: payload.artifactId,
    kind: payload.kind,
    title: payload.title,
    toolCallId:
      typeof payload.toolCallId === "string" && payload.toolCallId !== ""
        ? payload.toolCallId
        : null,
    type: "artifact",
    version: payload.version,
    versionId: payload.versionId,
  });
  return part.success ? part.data : null;
};

/** Where a new artifact card goes: after the tool call that made it and the cards already there, else at the end. */
const artifactIndex = (
  parts: ThreadPart[],
  toolCallId: string | null
): number => {
  const tool =
    toolCallId === null
      ? -1
      : parts.findIndex(
          (item) => item.type === "tool-call" && item.toolUseId === toolCallId
        );
  if (tool < 0) {
    return parts.length;
  }
  let index = tool + 1;
  while (parts[index]?.type === "artifact") {
    index += 1;
  }
  return index;
};

const addArtifact = (
  message: ThreadMessage,
  part: ArtifactThreadPart,
  cursor: Cursor
): void => {
  const existing = message.parts.findIndex(
    (item) => item.type === "artifact" && item.artifactId === part.artifactId
  );
  const current = message.parts[existing];
  if (current?.type === "artifact") {
    // One card per artifact and run. A later version replaces it in place and
    // an older one arriving late is dropped.
    if (part.version >= current.version) {
      message.parts[existing] = part;
    }
    return;
  }
  const index = artifactIndex(message.parts, part.toolCallId);
  message.parts.splice(index, 0, part);
  if (cursor.open && index <= cursor.open.start) {
    cursor.open.start += 1;
  }
};

const settle = (
  parts: ThreadPart[],
  requestId: unknown,
  status: RequestStatus,
  settlement?: Record<string, unknown>
): ThreadPart[] =>
  parts.map((part) =>
    part.type === "request" &&
    part.requestId === requestId &&
    // A settled card keeps its status. Only the closing event of the same
    // status may add its settlement details after the status-only frame.
    (part.status === "pending" ||
      (settlement !== undefined && part.status === status))
      ? { ...part, status, ...(settlement === undefined ? {} : { settlement }) }
      : part
  );

const applyTool = (
  message: ThreadMessage,
  event: ThreadEvent,
  cursor: Cursor
): void => {
  const { payload, type } = event;
  if (typeof payload.toolUseId !== "string") {
    return;
  }
  let tool = message.parts.find(
    (part) => part.type === "tool-call" && part.toolUseId === payload.toolUseId
  );
  if (tool?.type === "tool-call") {
    const index = message.parts.indexOf(tool);
    tool = { ...tool };
    message.parts[index] = tool;
  } else {
    tool = {
      input: null,
      name: null,
      ok: null,
      result: null,
      toolUseId: payload.toolUseId,
      type: "tool-call",
    };
    // A card whose tool call arrives after it goes after the call.
    const card = message.parts.findIndex(
      (part) =>
        part.type === "artifact" && part.toolCallId === payload.toolUseId
    );
    const at = card < 0 ? message.parts.length : card;
    message.parts.splice(at, 0, tool);
    if (cursor.open && at <= cursor.open.start) {
      cursor.open.start += 1;
    }
  }
  if (type === "tool.call") {
    tool.name = typeof payload.name === "string" ? payload.name : null;
    tool.input = payload.input ?? null;
  } else {
    tool.result = payload.output ?? null;
    tool.ok = typeof payload.ok === "boolean" ? payload.ok : null;
  }
};

const addReasoning = (
  message: ThreadMessage,
  text: string,
  cursor: Cursor
): void => {
  // Reasoning goes before the text of its own turn. A turn starts after the
  // last tool call, request, placeholder or earlier reasoning part.
  let index = 0;
  for (const [position, part] of message.parts.entries()) {
    if (part.type !== "text" && part.type !== "attachment") {
      index = position + 1;
    }
  }
  message.parts.splice(index, 0, { text, type: "reasoning" });
  if (cursor.open && index <= cursor.open.start) {
    cursor.open.start += 1;
  }
};

const applyPayload = (
  message: ThreadMessage,
  event: ThreadEvent,
  cursor: Cursor
): void => {
  const { payload, type } = event;
  if (type === "message.assistant") {
    const parts = textParts(
      typeof payload.text === "string" ? payload.text : ""
    );
    if (cursor.open) {
      message.parts.splice(cursor.open.start, cursor.open.count, ...parts);
      cursor.finished = cursor.open.key;
      cursor.open = undefined;
    } else {
      message.parts.push(...parts);
    }
  } else if (type === "message.reasoning" && typeof payload.text === "string") {
    addReasoning(message, payload.text, cursor);
  } else if (type === "tool.call" || type === "tool.result") {
    applyTool(message, event, cursor);
  } else if (type === "artifact.published") {
    const part = artifactPart(payload);
    if (part) {
      addArtifact(message, part, cursor);
    }
  } else if (type === "request.opened") {
    const part = requestPart(payload);
    if (
      part &&
      !message.parts.some(
        (item) => item.type === "request" && item.requestId === part.requestId
      )
    ) {
      message.parts.push(part);
    }
  } else if (
    type === "request.answered" ||
    type === "request.expired" ||
    type === "request.cancelled"
  ) {
    const statuses = {
      "request.answered": "answered",
      "request.cancelled": "cancelled",
      "request.expired": "expired",
    } as const;
    const status = statuses[type];
    message.parts = settle(message.parts, payload.requestId, status, payload);
  }
};

const userParts = (event: EventFrame): ThreadPart[] => {
  const payload = "payload" in event ? event.payload : {};
  const parts: ThreadPart[] = [];
  if (typeof payload.text === "string") {
    parts.push({ text: payload.text, type: "text" });
  }
  if (Array.isArray(payload.fileIds)) {
    for (const fileId of payload.fileIds) {
      if (typeof fileId === "string") {
        parts.push({ fileId, type: "attachment" });
      }
    }
  }
  if ("truncated" in event) {
    parts.push({
      eventId: event.id,
      eventType: event.type,
      type: "placeholder",
    });
  }
  return parts;
};

const applyAssistantFrame = (
  message: ThreadMessage,
  frame: StreamFrame,
  cursor: Cursor
): void => {
  if (frame.frame === "delta") {
    const parts = textParts(frame.text);
    if (cursor.open?.key === frame.messageKey) {
      message.parts.splice(cursor.open.start, cursor.open.count, ...parts);
      cursor.open.count = parts.length;
    } else {
      // V1 sends keys sequentially per run. Only the last completed key is kept,
      // rather than a session-long finishedKeys list; no text-prefix heuristic.
      cursor.open = {
        count: parts.length,
        key: frame.messageKey,
        start: message.parts.length,
      };
      message.parts.push(...parts);
    }
  } else if (frame.frame === "run") {
    message.status = statusOf(frame.status);
  } else if (frame.frame === "request") {
    message.parts = settle(message.parts, frame.requestId, frame.status);
    if (frame.status === "pending" && message.status === "running") {
      message.status = "waiting";
    }
  } else if (frame.frame === "event") {
    const event = frame;
    const status = eventStatus[event.type];
    if (status) {
      message.status = statusOf(status);
    }
    if ("truncated" in event) {
      if (event.type === "message.assistant" && cursor.open) {
        message.parts.splice(cursor.open.start, cursor.open.count);
        cursor.finished = cursor.open.key;
        cursor.open = undefined;
      }
      message.parts.push({
        eventId: event.id,
        eventType: event.type,
        type: "placeholder",
      });
    } else {
      applyPayload(message, event, cursor);
    }
  }
};

const copyMessage = (
  current: ThreadMessage | undefined,
  runId: string | null,
  createdAt: string | null
): ThreadMessage =>
  current
    ? {
        ...current,
        createdAt: current.createdAt ?? createdAt,
        parts: [...current.parts],
      }
    : {
        createdAt,
        id: `assistant:${runId}`,
        parts: [],
        role: "assistant",
        runId,
        status: "running",
      };

const isRelevant = (event: EventFrame | null): boolean =>
  !event ||
  event.type.startsWith("message.") ||
  event.type.startsWith("tool.") ||
  event.type.startsWith("request.") ||
  event.type === "artifact.published" ||
  eventStatus[event.type] !== undefined ||
  "truncated" in event;

const isLateDelta = (
  frame: StreamFrame,
  current: ThreadMessage | undefined,
  cursor: Cursor | undefined
): boolean =>
  frame.frame === "delta" &&
  ((current !== undefined && terminal(current.status)) ||
    cursor?.finished === frame.messageKey);

const userAttribution = (
  actor: ThreadActor,
  display: ThreadActorDisplay | undefined
): Pick<ThreadMessage, "actor" | "actorDisplay"> => ({
  actor: { ...actor },
  ...(display ? { actorDisplay: { name: display.name } } : {}),
});

/** Fold one frame immutably. Only stored event ids participate in replay detection. */
export const applyFrame = (
  messages: ThreadMessage[],
  frame: ThreadFrame
): ThreadMessage[] => {
  const previous = stateOf(messages);
  if (
    frame.frame === "ping" ||
    (frame.frame === "event" && previous.seen.has(frame.id))
  ) {
    return messages;
  }
  const event = frame.frame === "event" ? frame : null;
  const { runId } = frame;
  const index = messages.findIndex(
    (item) => item.role === "assistant" && item.runId === runId
  );
  const current = messages[index];
  const oldCursor = runId === null ? undefined : previous.cursors.get(runId);
  if (isLateDelta(frame, current, oldCursor)) {
    return messages;
  }
  const state: FoldState = {
    cursors: new Map(previous.cursors),
    seen: new Set(previous.seen),
  };
  if (event) {
    state.seen.add(event.id);
  }
  const next = [...messages];
  if (event?.type === "message.user") {
    const parts = userParts(event);
    // run.queued precedes message.user in storage; insert before its assistant shell.
    next.splice(index < 0 ? next.length : index, 0, {
      ...userAttribution(event.actor, frame.actorDisplay),
      createdAt: event.createdAt,
      id: event.id,
      parts,
      role: "user",
      runId,
      status: "done",
    });
    return attach(next, state);
  }
  if (!isRelevant(event)) {
    return attach(next, state);
  }
  if (runId === null) {
    // Runless events cannot be grouped by run; each is a standalone message.
    const standalone = copyMessage(undefined, null, event?.createdAt ?? null);
    standalone.id = event?.id ?? "runless";
    applyAssistantFrame(standalone, frame, {});
    next.push(standalone);
    return attach(next, state);
  }
  const message = copyMessage(current, runId, event?.createdAt ?? null);
  const cursor: Cursor = { ...oldCursor };
  if (oldCursor?.open) {
    cursor.open = { ...oldCursor.open };
  }
  state.cursors.set(runId, cursor);
  applyAssistantFrame(message, frame, cursor);
  if (current) {
    next[index] = message;
  } else {
    next.push(message);
  }
  return attach(next, state);
};

/** Events must be supplied in session order (tool results may precede calls). */
export const foldThread = (events: readonly ThreadEvent[]): ThreadMessage[] => {
  let messages: ThreadMessage[] = [];
  for (const event of events) {
    const base = {
      actor: event.actor ?? { id: "stored", kind: "system" as const },
      actorDisplay: event.actorDisplay,
      createdAt: event.createdAt,
      frame: "event" as const,
      id: event.id,
      runId: event.runId,
      seq: null,
      type: event.type,
    };
    const frame: EventFrame = event.payloadRef
      ? { ...base, truncated: true }
      : {
          ...base,
          payload: event.payload as Extract<
            EventFrame,
            { payload: unknown }
          >["payload"],
        };
    messages = applyFrame(messages, frame);
    if (!event.actor && event.type === "message.user") {
      const message = messages.find((item) => item.id === event.id);
      if (message) {
        message.actor = undefined;
        message.actorDisplay = undefined;
      }
    }
  }
  return messages;
};
