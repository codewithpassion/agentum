import type { Payload } from "./payload.ts";

const SUMMARY_MAX = 120;
/** Payload fields that say what happened, in the order they are tried. */
const SUMMARY_KEYS = ["text", "error", "name", "reason"] as const;

/** A short line for the event log: the first of `SUMMARY_KEYS` that holds text, cut to 120 characters. */
export const summarize = (payload: Payload): string => {
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
