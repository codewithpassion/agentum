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

const summarizeRefusal = (reason: unknown): string =>
  (typeof reason === "string" ? REFUSAL_SUMMARIES.get(reason) : undefined) ??
  REFUSED_SUMMARY;

/** A short line for the event log: the first of `SUMMARY_KEYS` that holds text, cut to 120 characters. */
export const summarize = (type: EventType, payload: Payload): string => {
  if (type === "slack.event_refused") {
    return summarizeRefusal(payload.reason);
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
