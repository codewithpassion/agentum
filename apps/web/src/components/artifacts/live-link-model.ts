import type { ArtifactGrantKind } from "@repo/db/shared";
import { format } from "date-fns";
import type { ExpiryChoice } from "./share-model";

export type DataMode = "live" | "snapshot";

/** The part of a grant row the share dialog reads. */
export interface GrantLike {
  kind: ArtifactGrantKind;
  status: "approved" | "pending" | "rejected";
  target: string;
}

/**
 * Tools a live link can expose: approved tool grants. Argument limits are
 * stored as extra rows `<tool>#<json>`, so any target with a `#` is left out.
 */
export function liveToolOptions(grants: readonly GrantLike[]): string[] {
  const keys = grants
    .filter(
      (grant) =>
        grant.kind === "tool" &&
        grant.status === "approved" &&
        !grant.target.includes("#")
    )
    .map((grant) => grant.target);
  return [...new Set(keys)];
}

/** Removes `#` argument-limit rows from any tool list shown to people. */
export const withoutArgumentLimits = (tools: readonly string[]): string[] =>
  tools.filter((tool) => !tool.includes("#"));

export const LIVE_WARNING =
  "Anyone with this link can run these tools as you until it expires or you revoke it. Every call is logged.";
export const NO_TOOLS_NOTE =
  "This version has no approved read-only tools to share.";

const DAYS: Partial<Record<ExpiryChoice, string>> = {
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
};

/** The chosen expiry in words, for the live-link warning. */
export function expiryText(choice: ExpiryChoice, date: string): string {
  if (choice === "never") {
    return "This link never expires.";
  }
  const days = DAYS[choice];
  if (days !== undefined) {
    return `This link expires in ${days}.`;
  }
  const parsed = new Date(`${date}T00:00:00`);
  if (date === "" || Number.isNaN(parsed.getTime())) {
    return "This link expires on the date you pick.";
  }
  return `This link expires on ${format(parsed, "d MMM yyyy")}.`;
}
