import type { ActionLogEntry, ActionLogKind } from "@repo/db/shared";
import type { EventRecord } from "../events.ts";
import { payloadOf, requestDetail, text, toolWords } from "./format.ts";

// The proxy records failures as outcomes (and can label HTTP 5xx as outcome "ok").
const connectorFailed = (
  event: EventRecord,
  payload: Record<string, unknown>
): boolean =>
  event.type.startsWith("connector.") &&
  (event.type !== "connector.call" ||
    payload.ok === false ||
    Boolean(payload.error) ||
    ["timeout", "unreachable", "refused", "blocked", "retry"].includes(
      text(payload.outcome)
    ) ||
    (typeof payload.httpStatus === "number" && payload.httpStatus >= 400));

const fallbackText = (
  event: EventRecord,
  payload: Record<string, unknown>
): string => {
  const label = toolWords(event.type);
  if (!event.type.startsWith("connector.")) {
    return label;
  }
  const reason = text(payload.outcome) || text(payload.cause);
  return reason ? `${label}: ${reason}` : label;
};

/** Preserve stream order and omit events with no action-log meaning. */
export const toActionLog = (
  events: readonly EventRecord[]
): ActionLogEntry[] => {
  const entries: ActionLogEntry[] = [];
  for (const event of events) {
    const payload = payloadOf(event);
    let kind: ActionLogKind;
    if (event.type === "message.reasoning") {
      kind = "thought";
    } else if (event.type === "tool.call") {
      kind = "tool_call";
    } else if (event.type === "tool.result") {
      kind = payload.ok === false ? "error" : "tool_result";
    } else if (
      event.type.startsWith("request.") ||
      event.type === "run.limit_reached"
    ) {
      kind = "note";
    } else if (event.type === "run.failed" || connectorFailed(event, payload)) {
      kind = "error";
    } else {
      continue;
    }
    entries.push({
      at: event.createdAt,
      eventId: event.id,
      kind,
      text:
        text(payload.text) ||
        text(payload.error) ||
        text(payload.output) ||
        requestDetail(payload.display) ||
        text(payload.name) ||
        fallbackText(event, payload),
    });
  }
  return entries;
};
