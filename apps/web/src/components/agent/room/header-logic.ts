import type { WorkspaceMember } from "@repo/db/shared";
import { effectiveOwner } from "#/components/agent/profile/asks-logic.ts";

const JOB_LINE_MAX = 120;

/** The first line of the instructions, cut at a word near 120 characters. */
export const jobLine = (does: string): string | null => {
  const first = does
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === undefined) {
    return null;
  }
  if (first.length <= JOB_LINE_MAX) {
    return first;
  }
  const cut = first.slice(0, JOB_LINE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** The owner's name for the header, or null when the member lookup failed or the owner left. */
export const ownerName = (
  agent: { createdBy: string; ownerUserId: string | null },
  members: WorkspaceMember[] | null
): string | null => {
  if (members === null) {
    return null;
  }
  const owner = effectiveOwner(agent, members);
  return owner === null ? null : owner.name;
};
