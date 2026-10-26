import {
  AGENT_RUNTIMES,
  type ProfileGap,
  VOICE_PRESETS,
} from "@repo/db/shared";
import { z } from "zod";
import { validateCron } from "../routines/cron.ts";

const id = z.string().min(1);
const runtimeSchema = z.enum(AGENT_RUNTIMES).exclude(["fake"]);
const routineSchema = z
  .strictObject({
    cron: z.string(),
    kind: z.literal("routine"),
    label: z.string().min(1).max(80),
    prompt: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
  })
  .transform((routine) => ({
    ...routine,
    prompt: routine.prompt ?? routine.label,
  }));

// Rules and library paths are lists; sample input uses the shared key-chip shape.
// Cron syntax is reconciled into a gap rather than rejecting the entire draft.
export const agentDraftSchema = z.strictObject({
  does: z
    .string()
    .min(1)
    .describe(
      "What the agent does, in plain prose. Do not put the rules here and do not add a Rules: block. Rules go in the rules field."
    ),
  handsTo: z.array(id),
  library: z.array(id),
  name: z.string().min(1),
  rules: z
    .array(z.string().min(1))
    .describe(
      "One rule per entry. This is the only place for rules, never repeat them in does."
    ),
  runsOn: z
    .strictObject({ machineId: id.optional(), runtime: runtimeSchema })
    .nullable(),
  sampleInput: z.array(z.strictObject({ key: id, value: z.string() })),
  skills: z.array(id),
  startsOn: z.array(
    z.union([
      routineSchema,
      z.strictObject({ kind: z.literal("mail") }),
      z.strictObject({ kind: z.literal("slack_mention") }),
    ])
  ),
  tools: z.array(id),
  voice: z.enum(VOICE_PRESETS),
});

export type AgentDraft = z.output<typeof agentDraftSchema>;
export type BuilderRuntime = z.infer<typeof runtimeSchema>;

export interface BuilderCatalog {
  agents: { id: string; name: string; does: string }[];
  connectors: {
    id: string;
    name: string;
    description: string;
    /** Only assigned tools inside allowedTools; readOnly is the cached flag. */
    tools: { name: string; readOnly: boolean }[];
  }[];
  machines: { id: string; name: string; online: boolean }[];
  /** Runtimes whose provider keys are present, not secret values. */
  runtimes: BuilderRuntime[];
  skills: { id: string; name: string; description: string }[];
}

type SelectionField = "tools" | "skills" | "handsTo";
const selections = [
  { catalog: "connectors", field: "tools", key: "tools", noun: "connector" },
  { catalog: "skills", field: "skills", key: "skills", noun: "skill" },
  { catalog: "agents", field: "hands_to", key: "handsTo", noun: "agent" },
] as const;

const reconcileSelections = (
  draft: AgentDraft,
  catalog: BuilderCatalog,
  locked: Partial<AgentDraft>,
  gaps: ProfileGap[]
): void => {
  for (const selection of selections) {
    const known = new Set(catalog[selection.catalog].map((item) => item.id));
    const kept = draft[selection.key].filter((selectedId) => {
      if (known.has(selectedId)) {
        return true;
      }
      gaps.push({
        field: selection.field,
        question: `No ${selection.noun} for ${selectedId} yet. Add one or remove it`,
      });
      return false;
    });
    if (locked[selection.key] === undefined) {
      draft[selection.key] = kept;
    }
  }
};

const validRuntime = (draft: AgentDraft, catalog: BuilderCatalog): boolean => {
  const { runsOn } = draft;
  if (!(runsOn && catalog.runtimes.includes(runsOn.runtime))) {
    return false;
  }
  return (
    runsOn.runtime !== "machine" ||
    catalog.machines.some((machine) => machine.id === runsOn.machineId)
  );
};

const startLines = (draft: AgentDraft): string[] =>
  draft.startsOn.flatMap((start) => {
    switch (start.kind) {
      case "mail":
        return ["Mail starts it once the inbox arrives (V5)"];
      case "slack_mention":
        return ["Starts on a Slack mention"];
      case "routine":
        return validateCron(start.cron)
          ? []
          : [`Starts on ${start.label} (${start.cron})`];
      default:
        return [];
    }
  });

const runtimeLines = (draft: AgentDraft, catalog: BuilderCatalog): string[] => {
  if (!(draft.runsOn && validRuntime(draft, catalog))) {
    return [];
  }
  if (draft.runsOn.runtime !== "machine") {
    return [`Runs on ${draft.runsOn.runtime}`];
  }
  const machine = catalog.machines.find(
    (item) => item.id === draft.runsOn?.machineId
  );
  return machine
    ? [
        `Runs on ${machine.name}`,
        ...(machine.online ? [] : [`${machine.name} is offline`]),
      ]
    : [];
};

const didListFor = (draft: AgentDraft, catalog: BuilderCatalog): string[] => {
  const lines = [
    `Named it ${draft.name}`,
    `Does: ${draft.does}`,
    `Voice: ${draft.voice}`,
    ...draft.rules.map((rule) => `Rule: ${rule}`),
  ];
  const descriptions: Record<SelectionField, string> = {
    handsTo: "Hands to",
    skills: "Uses skill",
    tools: "Uses connector",
  };
  for (const selection of selections) {
    for (const selectedId of draft[selection.key]) {
      const item = catalog[selection.catalog].find(
        (entry) => entry.id === selectedId
      );
      if (item) {
        lines.push(`${descriptions[selection.key]} ${item.name}`);
      }
    }
  }
  return [
    ...lines,
    ...startLines(draft),
    ...runtimeLines(draft, catalog),
    ...draft.library.map((path) => `Uses library path ${path}`),
    ...draft.sampleInput.map(
      (chip) => `Sample input ${chip.key}: ${chip.value}`
    ),
  ];
};

// A line that opens a rules block: "Rules:", "**Rules:**" or a "## Rules" heading.
const RULES_BLOCK =
  /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+[*_]*rules[*_]*[ \t]*:?|[*_]*rules[*_]*[ \t]*:)[\s\S]*$/i;

/** The model sometimes repeats the rules as a last block of does. Keep them in rules only. */
const stripRulesBlock = (does: string): string => {
  const stripped = does.replace(RULES_BLOCK, "").trim();
  return stripped === "" ? does : stripped;
};

/** Pure reconciliation: malformed structure throws ZodError; unresolved choices are gaps. */
export const reconcileDraft = (
  raw: unknown,
  catalog: BuilderCatalog,
  locked: Partial<AgentDraft> = {}
): { draft: AgentDraft; gaps: ProfileGap[]; didList: string[] } => {
  // Locked is a partial draft of edited values, not field names. User edits win
  // even when stale catalogue entries need a gap; only model choices are dropped.
  const draft = agentDraftSchema.parse({
    ...z.record(z.string(), z.unknown()).parse(raw),
    ...Object.fromEntries(
      Object.entries(locked).filter(([, value]) => value !== undefined)
    ),
  });
  if (locked.does === undefined) {
    draft.does = stripRulesBlock(draft.does);
  }
  const gaps: ProfileGap[] = [];
  reconcileSelections(draft, catalog, locked, gaps);
  const startsOn = draft.startsOn.filter((start) => {
    if (start.kind !== "routine") {
      return true;
    }
    const error = validateCron(start.cron);
    if (!error) {
      return true;
    }
    gaps.push({
      field: "starts_on",
      question: `Choose a valid schedule for ${start.label}: ${error}`,
    });
    return false;
  });
  if (locked.startsOn === undefined) {
    draft.startsOn = startsOn;
  }
  if (!validRuntime(draft, catalog)) {
    gaps.push({ field: "runs_on", question: "Where it runs" });
    if (locked.runsOn === undefined) {
      draft.runsOn = null;
    }
  }
  return { didList: didListFor(draft, catalog), draft, gaps };
};
