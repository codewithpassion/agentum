import type { JobSentence, ProposedTrigger } from "@repo/db/shared";
import { formatDistance } from "date-fns";

export type JobChipKind = "when" | "agent" | "does" | "asks" | "delivers";

export interface JobChip {
  kind: JobChipKind;
  text: string;
}

export type DraftSaveKind = "routine" | "http" | "mail" | "unsupported";

const DRAFT_NAME_MAX_CHARS = 80;
const DRAFT_NAME_FALLBACK = "New job";

const isPresent = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

interface ChipParts {
  agentName: string | null;
  asksBefore: string | null;
  deliversTo: string | null;
  does: string;
  when: string;
}

const buildChips = (parts: ChipParts): JobChip[] => {
  const chips: JobChip[] = [];
  if (isPresent(parts.when)) {
    chips.push({ kind: "when", text: parts.when });
  }
  if (parts.agentName !== null) {
    chips.push({ kind: "agent", text: parts.agentName });
  }
  if (isPresent(parts.does)) {
    chips.push({ kind: "does", text: parts.does });
  }
  if (isPresent(parts.asksBefore)) {
    chips.push({ kind: "asks", text: `Asks first: ${parts.asksBefore}` });
  }
  if (isPresent(parts.deliversTo)) {
    chips.push({ kind: "delivers", text: `Sends to ${parts.deliversTo}` });
  }
  return chips;
};

export const jobChips = (
  job: Pick<
    JobSentence,
    "agent" | "asksBefore" | "deliversTo" | "does" | "when"
  >,
  options: { showAgent: boolean }
): JobChip[] =>
  buildChips({
    agentName: options.showAgent ? job.agent.name : null,
    asksBefore: job.asksBefore,
    deliversTo: job.deliversTo,
    does: job.does,
    when: job.when,
  });

export const draftChips = (draft: ProposedTrigger): JobChip[] =>
  buildChips({
    agentName: null,
    asksBefore: draft.asksBefore,
    deliversTo: draft.deliversTo,
    does: draft.does,
    when: draft.when,
  });

const outcomeWord = (lastRunOk: boolean | null): string => {
  if (lastRunOk === null) {
    return "running";
  }
  return lastRunOk ? "ok" : "failed";
};

export const lastResultText = (
  job: Pick<JobSentence, "lastRunAt" | "lastRunOk">,
  nowMs: number | null
): string => {
  if (job.lastRunAt === null) {
    return "Not run yet";
  }
  const outcome = outcomeWord(job.lastRunOk);
  if (nowMs === null) {
    return `Last run ${outcome}`;
  }
  const distance = formatDistance(new Date(job.lastRunAt), new Date(nowMs), {
    addSuffix: true,
  });
  return `Last run ${outcome}, ${distance}`;
};

export const canRunNow = (
  job: Pick<JobSentence, "awaitingApproval" | "source">
): boolean => job.source === "routine" && !job.awaitingApproval;

export const canPause = (
  job: Pick<JobSentence, "awaitingApproval" | "source">
): boolean => job.source !== "slack" && !job.awaitingApproval;

/** Which procedure approves a proposed job: a routine, or a web, mail or app trigger. */
export const approvalTarget = (
  job: Pick<JobSentence, "source">
): "routine" | "trigger" => (job.source === "routine" ? "routine" : "trigger");

/** Which procedure pauses a job: routines and web triggers have their own, mail is the agent's mailbox. */
export const pauseTarget = (
  job: Pick<JobSentence, "source">
): "mail" | "routine" | "trigger" => {
  if (job.source === "routine") {
    return "routine";
  }
  return job.source === "mail" ? "mail" : "trigger";
};

export const draftSaveKind = (draft: ProposedTrigger): DraftSaveKind => {
  if (draft.source === "routine") {
    return isPresent(draft.cron) ? "routine" : "unsupported";
  }
  if (draft.source === "http") {
    return "http";
  }
  if (draft.source === "mail") {
    return "mail";
  }
  return "unsupported";
};

export const draftName = (does: string): string => {
  const firstLine = does
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (firstLine === undefined) {
    return DRAFT_NAME_FALLBACK;
  }
  const characters = [...firstLine];
  if (characters.length <= DRAFT_NAME_MAX_CHARS) {
    return firstLine;
  }
  return characters.slice(0, DRAFT_NAME_MAX_CHARS).join("").trimEnd();
};

export const draftRoutineInput = (
  agentId: string,
  draft: ProposedTrigger
): {
  agentId: string;
  cron: string;
  name: string;
  prompt: string;
  timezone?: string;
} => {
  if (!isPresent(draft.cron)) {
    throw new Error("A routine needs a cron schedule to be saved.");
  }
  const does = draft.does.trim();
  const input = {
    agentId,
    cron: draft.cron,
    name: draftName(draft.does),
    prompt: does === "" ? draft.when.trim() : does,
  };
  if (isPresent(draft.timezone)) {
    return { ...input, timezone: draft.timezone };
  }
  return input;
};
