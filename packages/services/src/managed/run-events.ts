import type { Database } from "@repo/db";
import { events } from "@repo/db/schema/events";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Payload } from "../events/payload.ts";
import type { RunEventInput } from "../runs/types.ts";
import type { SessionEvent } from "./events.ts";

/**
 * The run events for a page of session events, numbered from `firstSeq`. An
 * event that is not a message, a call or a result (status changes, thinking,
 * errors) becomes nothing, and takes no seq.
 */
export const toRunEvents = (
  page: readonly SessionEvent[],
  firstSeq: number
): { events: RunEventInput[]; nextSeq: number } => {
  const mapped: RunEventInput[] = [];
  let seq = firstSeq;
  for (const event of page) {
    const entry = toRunEvent(event);
    if (entry) {
      mapped.push({ ...entry, seq });
      seq += 1;
    }
  }
  return { events: mapped, nextSeq: seq };
};

const toRunEvent = (
  event: SessionEvent
): Omit<RunEventInput, "seq"> | undefined => {
  if (event.type === "agent.message" && event.text) {
    return { payload: { text: event.text }, type: "message.assistant" };
  }
  if (event.tool) {
    return {
      payload: {
        input: event.tool.input as Payload,
        name: event.tool.name,
        toolUseId: event.tool.id,
      },
      type: "tool.call",
    };
  }
  if (event.result) {
    return {
      payload: {
        ok: !event.result.isError,
        output: event.result.text,
        toolUseId: event.result.toolUseId,
      },
      type: "tool.result",
    };
  }
};

const textOf = (payload: string | null): string => {
  try {
    const parsed: unknown = JSON.parse(payload ?? "{}");
    const text =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { text?: unknown }).text
        : undefined;
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
};

/**
 * What the agent said last: its messages after the final tool call or result
 * of the run. A run that never used a tool answers with all its messages.
 */
export const finalReply = async (
  db: Database,
  run: { id: string; workspaceId: string }
): Promise<string> => {
  const rows = await db
    .select({ payload: events.payload, type: events.type })
    .from(events)
    .where(
      and(
        eq(events.runId, run.id),
        eq(events.workspaceId, run.workspaceId),
        inArray(events.type, ["message.assistant", "tool.call", "tool.result"])
      )
    )
    .orderBy(asc(events.seq), asc(events.id));
  const lastTool = rows.findLastIndex(
    (row) => row.type !== "message.assistant"
  );
  return rows
    .slice(lastTool + 1)
    .filter((row) => row.type === "message.assistant")
    .map((row) => textOf(row.payload))
    .filter((text) => text !== "")
    .join("\n\n");
};
