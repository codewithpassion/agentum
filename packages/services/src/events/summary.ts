import type { EventType } from "@repo/db/shared";
import type { Payload } from "./payload.ts";

const SUMMARY_MAX = 120;
/** Payload fields that say what happened, in the order they are tried. */
const SUMMARY_KEYS = ["text", "error", "name", "reason"] as const;
const REFUSED_SUMMARY = "Slack event refused.";
const REFUSAL_SUMMARIES = new Map<string, string>([
  [
    "signature",
    "Slack event refused: signature didn't match. Check the signing secret in the agent's Slack settings.",
  ],
  [
    "team",
    "Slack event refused: wrong Slack workspace for this agent's app. Check where the app is installed.",
  ],
]);
const CANCELLED_SUMMARY = "Cancelled";
const SYSTEM_CANCELLED_SUMMARY = "Cancelled by the system";

const summarizeRefusal = (reason: unknown): string =>
  (typeof reason === "string" ? REFUSAL_SUMMARIES.get(reason) : undefined) ??
  REFUSED_SUMMARY;

/** Who cancelled a run: a person, the system, or nobody recorded. */
const summarizeCancel = (actor?: { id: string; kind: string }): string => {
  if (actor?.kind === "user") {
    return `Cancelled by user ${actor.id}`;
  }
  if (actor?.kind === "system") {
    return SYSTEM_CANCELLED_SUMMARY;
  }
  return CANCELLED_SUMMARY;
};

/** A short line for the event log: the first of `SUMMARY_KEYS` that holds text, cut to 120 characters. */
export const summarize = (
  type: EventType,
  payload: Payload,
  actor?: { id: string; kind: string }
): string => {
  if (type === "slack.event_refused") {
    return summarizeRefusal(payload.reason);
  }
  if (type === "run.cancelled") {
    return summarizeCancel(actor);
  }
  for (const key of SUMMARY_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      const line = value.trim().replace(/\s+/g, " ");
      return line.length > SUMMARY_MAX
        ? `${line.slice(0, SUMMARY_MAX)}...`
        : line;
    }
  }
  return "";
};
