import type { ProfileGap } from "@repo/db/shared";
import type {
  AgentDraft,
  BuilderCatalog,
} from "@repo/services/agent-builder/draft";
import type { EventRecord } from "@repo/services/events";

export type SampleChip = AgentDraft["sampleInput"][number];

/** Returns a copy of the sample with the chip at `index` patched. An index out of range changes nothing. */
export const updateChip = (
  sample: readonly SampleChip[],
  index: number,
  patch: Partial<SampleChip>
): SampleChip[] =>
  sample.map((chip, i) => (i === index ? { ...chip, ...patch } : chip));

/** Returns a copy of the sample without the chip at `index`. An index out of range changes nothing. */
export const removeChip = (
  sample: readonly SampleChip[],
  index: number
): SampleChip[] => sample.filter((_, i) => i !== index);

/** Returns a copy of the sample with a blank chip at the end. */
export const addChip = (sample: readonly SampleChip[]): SampleChip[] => [
  ...sample,
  { key: "", value: "" },
];

/** Trims each chip and drops those with a blank key, since the server requires one. */
export const cleanSample = (sample: readonly SampleChip[]): SampleChip[] =>
  sample
    .map((chip) => ({ key: chip.key.trim(), value: chip.value.trim() }))
    .filter((chip) => chip.key !== "");

/** The draft as the server should receive it: the sample cleaned. */
export const serverDraft = (draft: AgentDraft): AgentDraft => ({
  ...draft,
  sampleInput: cleanSample(draft.sampleInput),
});

/** A key for the draft as saved. The saved row does not hold the sample, so the sample is left out. */
export const draftSaveKey = (draft: AgentDraft): string => {
  const { sampleInput: _sample, ...saved } = draft;
  return JSON.stringify(saved);
};

/** Why the dry run cannot start yet, or null. Address gaps do not block it. */
export const createBlocker = (gaps: readonly ProfileGap[]): string | null => {
  const blocking = gaps.filter((gap) => gap.field !== "address");
  if (blocking.length === 0) {
    return null;
  }
  return `Decide first: ${blocking.map((gap) => gap.question).join(" ")}`;
};

/** One line per skipped tool call in the run, in event order. Malformed payloads are skipped. */
export const wouldLines = (
  events: readonly Pick<EventRecord, "type" | "payload">[]
): string[] => {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== "run.dry_run_skipped") {
      continue;
    }
    const { tool, summary } = event.payload;
    if (typeof tool === "string" && typeof summary === "string") {
      lines.push(`Would call ${tool} with ${summary}`);
    }
  }
  return lines;
};

/**
 * Where the dry run runs and whether it can. It always runs on Cloudflare, so
 * it needs a model key there, and a machine or Anthropic cloud agent is told
 * its own runtime is not the one tried.
 */
export const dryRunRuntime = (
  catalog: BuilderCatalog,
  runsOn: AgentDraft["runsOn"]
): { blocker: string | null; note: string } => {
  if (!catalog.runtimes.includes("cloud")) {
    return {
      blocker:
        "A dry run needs an OpenRouter or Anthropic key in Settings. You can still create the agent without one.",
      note: "The dry run runs on Cloudflare and needs a model key.",
    };
  }
  if (runsOn === null || runsOn.runtime === "cloud") {
    return {
      blocker: null,
      note:
        runsOn === null
          ? "The dry run runs on Cloudflare."
          : "The dry run runs on Cloudflare, the runtime you chose.",
    };
  }
  const label =
    runsOn.runtime === "machine"
      ? (catalog.machines.find((machine) => machine.id === runsOn.machineId)
          ?.name ?? "That machine")
      : "Anthropic cloud";
  return {
    blocker: null,
    note: `The dry run runs on Cloudflare. ${label} cannot run a dry run yet, so the real agent runs there.`,
  };
};
