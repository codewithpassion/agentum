import { readEnvelope } from "../connectors/mcp.ts";
import type { ProxyAccess, ToolRunEvent, ToolRunResult } from "./fake-tool.ts";

/**
 * The dev-only fake runtime's way to act as a team lead. A lead's room run
 * calls its team tools through the app's own `/mcp` route with its run token,
 * so the route's team-room tool filter and the lead checks apply exactly as
 * they do for a real lead. Failures come back as reply text, never as a throw.
 *
 * Two markers in the post text drive it:
 * - `assign:handle` calls `team_post` in the room to wake that member. Write it
 *   without the `@`: an `@handle` in the person's post would wake that member
 *   itself, and the lead would never run.
 * - `team_propose_change:<field>=<value>` reads `team_members`, then calls
 *   `team_propose_change` for a member named with an `@handle` in the text, or
 *   the first member agent that is not the lead.
 */

export interface LeadRunInput {
  proxy: ProxyAccess;
  runToken: string;
  /** The task text. */
  text: string;
  /** The room topic's id, where `team_post` posts. */
  threadId: string;
}

const ASSIGN_MARKER = /assign:@?([A-Za-z0-9_-]+)/;
const PROPOSE_MARKER = /team_propose_change:([A-Za-z]+)=([^\n]+)/;
const ASSIGN_MARKER_ALL = /assign:@?[A-Za-z0-9_-]+/g;
const PROPOSE_MARKER_ALL = /team_propose_change:[^\n]*/g;
const MENTION = /@([A-Za-z0-9_-]+)/g;
// The wake input is the post text, then a tail that starts with this line. The
// tail and the earlier posts after it hold no markers of this post.
const WAKE_TAIL = "\n\nYour final answer is your reply.";
const FORBIDDEN = 403;
const MAX_OUTPUT_LENGTH = 8000;
const MAX_REPLY_TEXT_LENGTH = 2000;
const PROPOSE_REASON = "The fake lead proposed this change from the room.";
const UNREACHABLE = "The /mcp route could not be reached.";
const NO_SENT_ANSWER = "The /mcp route sent no answer.";
const UNKNOWN_ERROR = "unknown error";
const NO_MEMBER = "The team has no member agent to propose a change to.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clip = (text: string): string =>
  text.length > MAX_REPLY_TEXT_LENGTH
    ? `${text.slice(0, MAX_REPLY_TEXT_LENGTH)}...`
    : text;

/** The part of the input the person wrote. */
const leadingText = (text: string): string => text.split(WAKE_TAIL)[0] ?? text;

/** Whether the post text asks the fake lead to use a team tool. */
export const wantsLead = (text: string): boolean => {
  const leading = leadingText(text);
  return ASSIGN_MARKER.test(leading) || PROPOSE_MARKER.test(leading);
};

interface Member {
  handle: string | null;
  id: string;
}

const membersOf = (data: unknown): Member[] => {
  const list: unknown[] =
    isRecord(data) && Array.isArray(data.members) ? data.members : [];
  return list.flatMap((entry) =>
    isRecord(entry) &&
    entry.kind === "agent" &&
    entry.isLead !== true &&
    typeof entry.id === "string"
      ? [
          {
            handle: typeof entry.handle === "string" ? entry.handle : null,
            id: entry.id,
          },
        ]
      : []
  );
};

interface CallResult {
  data: unknown;
  ok: boolean;
  text: string;
}

interface Run {
  events: ToolRunEvent[];
  input: LeadRunInput;
  requestCount: number;
  toolUses: number;
}

/** Adds one `tool.call` and its `tool.result`, with the next toolUseId. */
const record = (
  run: Run,
  name: string,
  input: Record<string, string>,
  result: CallResult
): void => {
  run.toolUses += 1;
  const toolUseId = `fake-lead-${run.toolUses}`;
  run.events.push({
    payload: { input, name, toolUseId },
    type: "tool.call",
  });
  run.events.push({
    payload: {
      ok: result.ok,
      output: result.text.slice(0, MAX_OUTPUT_LENGTH),
      toolUseId,
    },
    type: "tool.result",
  });
};

const failed = (text: string): CallResult => ({
  data: undefined,
  ok: false,
  text,
});

/** Sends one JSON-RPC message to `/mcp`, outside any call's record. Never throws. */
const send = async (
  run: Run,
  method: string,
  params: Record<string, unknown>
): Promise<CallResult> => {
  run.requestCount += 1;
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${run.input.runToken}`,
    "content-type": "application/json",
  };
  let response: Response;
  try {
    response = await run.input.proxy.fetch(
      new Request(`${run.input.proxy.baseUrl}/mcp`, {
        body: JSON.stringify({
          id: run.requestCount,
          jsonrpc: "2.0",
          method,
          params,
        }),
        headers,
        method: "POST",
      })
    );
  } catch {
    return failed(UNREACHABLE);
  }
  if (response.status === FORBIDDEN) {
    return failed("The /mcp route refused the call.");
  }
  if (!response.ok) {
    return failed(`The /mcp route answered ${response.status}.`);
  }
  try {
    const envelope = await readEnvelope(response);
    if (!envelope) {
      return failed(NO_SENT_ANSWER);
    }
    if (envelope.error) {
      return failed(envelope.error.message ?? UNKNOWN_ERROR);
    }
    const result = envelope.result ?? {};
    const content: unknown[] = Array.isArray(result.content)
      ? result.content
      : [];
    const text = content
      .flatMap((entry) =>
        isRecord(entry) &&
        entry.type === "text" &&
        typeof entry.text === "string"
          ? [entry.text]
          : []
      )
      .join("\n");
    return {
      data: result.structuredContent,
      ok: result.isError !== true,
      text,
    };
  } catch {
    return failed(UNREACHABLE);
  }
};

/** Calls one tool and records it as a `tool.call` and `tool.result`. */
const callTool = async (
  run: Run,
  name: string,
  args: Record<string, string>
): Promise<CallResult> => {
  const result = await send(run, "tools/call", { arguments: args, name });
  record(run, name, args, result);
  return result;
};

const assign = async (run: Run, handle: string, text: string) => {
  const task = text
    .replaceAll(ASSIGN_MARKER_ALL, "")
    .replaceAll(PROPOSE_MARKER_ALL, "")
    .replaceAll(MENTION, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const post = `@${handle} Please take this${task ? `: ${task}` : "."}`;
  const result = await callTool(run, "team_post", {
    text: post,
    topic: run.input.threadId,
  });
  return result.ok
    ? `Assigned this to ${handle}.`
    : `team_post failed: ${clip(result.text)}`;
};

const propose = async (
  run: Run,
  field: string,
  value: string,
  text: string
) => {
  const members = await callTool(run, "team_members", {});
  if (!members.ok) {
    return `team_members failed: ${clip(members.text)}`;
  }
  const agents = membersOf(members.data);
  const mentioned = new Set(
    [...text.matchAll(MENTION)].map((match) => match[1]?.toLowerCase())
  );
  const target =
    agents.find(
      (member) => member.handle && mentioned.has(member.handle.toLowerCase())
    ) ?? agents[0];
  if (!target) {
    return NO_MEMBER;
  }
  const result = await callTool(run, "team_propose_change", {
    agentId: target.id,
    field,
    reason: PROPOSE_REASON,
    value: value.trim(),
  });
  return result.ok
    ? clip(result.text)
    : `team_propose_change failed: ${clip(result.text)}`;
};

/** Runs the marked steps in order and answers with one line per step. */
export const runLead = async (input: LeadRunInput): Promise<ToolRunResult> => {
  const run: Run = {
    events: [],
    input,
    requestCount: 0,
    toolUses: 0,
  };
  const text = leadingText(input.text);
  const lines: string[] = [];
  const handle = ASSIGN_MARKER.exec(text)?.[1];
  if (handle) {
    lines.push(await assign(run, handle, text));
  }
  const proposal = PROPOSE_MARKER.exec(text);
  if (proposal?.[1] && proposal[2]) {
    lines.push(await propose(run, proposal[1], proposal[2], text));
  }
  return { events: run.events, text: lines.join("\n") };
};
