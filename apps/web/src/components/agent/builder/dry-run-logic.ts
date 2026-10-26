import type { ProfileGap } from "@repo/db/shared";
import type { AgentDraft } from "@repo/services/agent-builder/draft";
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
