import type { ProfileField, ProfileGap } from "@repo/db/shared";
import type {
  AgentDraft,
  BuilderCatalog,
} from "@repo/services/agent-builder/draft";

/** Mirrors the description limit in `@repo/services/agent-builder/service`, which the browser cannot import. */
export const DESCRIPTION_LIMIT = 8000;
export const MAX_IMPORT_BYTES = 200 * 1024;

const TEXT_FILE = /\.(md|txt)$/i;
const NON_ADDRESS = /[^a-z0-9]+/g;
const EDGE_DASH = /^-+|-+$/g;
const ADDRESS_MAX = 40;
const LINE_BREAK = /\r?\n/;

/** The fields the person edited. Redraft sends them as `locked`, so the builder keeps them. */
export type Locked = Partial<AgentDraft>;

/** Applies an edit to the draft and remembers it as locked. */
export const applyEdit = (
  draft: AgentDraft,
  locked: Locked,
  patch: Partial<AgentDraft>
): { draft: AgentDraft; locked: Locked } => ({
  draft: { ...draft, ...patch },
  locked: { ...locked, ...patch },
});

/** Why the draft cannot go back to the builder yet, or null. The builder needs a name and a "does". */
export const redraftBlocker = (draft: AgentDraft): string | null => {
  if (draft.name.trim() === "") {
    return "Name the agent before you redraft.";
  }
  if (draft.does.trim() === "") {
    return "Say what the agent does before you redraft.";
  }
  return null;
};

export const isLocked = (locked: Locked, field: keyof AgentDraft): boolean =>
  locked[field] !== undefined;

const GAP_FIELD: Record<ProfileField, keyof AgentDraft | null> = {
  address: null,
  does: "does",
  hands_to: "handsTo",
  library: "library",
  rules: "rules",
  runs_on: "runsOn",
  skills: "skills",
  starts_on: "startsOn",
  tools: "tools",
  voice: "voice",
};

/** Gaps the person has not settled: editing a field settles its gap, but a runtime must be chosen. */
export const openGaps = (
  gaps: readonly ProfileGap[],
  draft: AgentDraft,
  locked: Locked
): ProfileGap[] =>
  gaps.filter((gap) => {
    const field = GAP_FIELD[gap.field];
    if (field === null || !isLocked(locked, field)) {
      return true;
    }
    return field === "runsOn" && draft.runsOn === null;
  });

export const decideText = (count: number): string | null => {
  if (count === 0) {
    return null;
  }
  return count === 1 ? "1 thing to decide" : `${count} things to decide`;
};

export interface BuilderStep {
  done: boolean;
  label: string;
}

/** "What the builder did" as checked lines, then what it waits for as open ones. */
export const builderSteps = (
  didList: readonly string[],
  gaps: readonly ProfileGap[]
): BuilderStep[] => [
  ...didList.map((label) => ({ done: true, label })),
  ...gaps.map((gap) => ({
    done: false,
    label: `Waiting for you: ${gap.question}`,
  })),
];

/** Why a file cannot be imported, or null. Text only, up to 200 KB. */
export const importFileError = (file: {
  name: string;
  size: number;
}): string | null => {
  if (!TEXT_FILE.test(file.name)) {
    return "Import a .md or .txt file.";
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return "That file is over 200 KB.";
  }
  return null;
};

/** Why imported text cannot go into the description box, or null. */
export const importTextError = (text: string): string | null => {
  if (text.trim() === "") {
    return "That file is empty.";
  }
  if (text.length > DESCRIPTION_LIMIT) {
    return `The description holds ${DESCRIPTION_LIMIT} characters. Trim the file first.`;
  }
  return null;
};

/** The address to start from: the name as lowercase words joined by dashes. */
export const addressSuggestion = (name: string): string =>
  name
    .toLowerCase()
    .replace(NON_ADDRESS, "-")
    .replace(EDGE_DASH, "")
    .slice(0, ADDRESS_MAX)
    .replace(EDGE_DASH, "");

export const rulesOf = (text: string): string[] =>
  text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Adds the id when absent, removes it when present. */
export const toggleId = (ids: readonly string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];

type Start = AgentDraft["startsOn"][number];

/** Turns a mail or Slack-mention start on or off. Routine starts keep their place. */
export const toggleStart = (
  startsOn: readonly Start[],
  kind: "mail" | "slack_mention"
): Start[] =>
  startsOn.some((start) => start.kind === kind)
    ? startsOn.filter((start) => start.kind !== kind)
    : [...startsOn, { kind }];

export interface RunsOnOption {
  key: string;
  label: string;
  /** Only the current machine's online state shows. */
  note: string | null;
  selected: boolean;
  value: NonNullable<AgentDraft["runsOn"]>;
}

const RUNTIME_LABELS = {
  cloud: "Cloudflare",
  managed: "Anthropic cloud",
} as const;

/** Where the agent can run in this workspace: each usable runtime and each machine. */
export const runsOnOptions = (
  catalog: BuilderCatalog,
  runsOn: AgentDraft["runsOn"]
): RunsOnOption[] => {
  const options: RunsOnOption[] = [];
  for (const runtime of ["managed", "cloud"] as const) {
    if (catalog.runtimes.includes(runtime)) {
      options.push({
        key: runtime,
        label: RUNTIME_LABELS[runtime],
        note: null,
        selected: runsOn?.runtime === runtime,
        value: { runtime },
      });
    }
  }
  if (catalog.runtimes.includes("machine")) {
    for (const machine of catalog.machines) {
      options.push({
        key: `machine:${machine.id}`,
        label: machine.name,
        note: machine.online ? null : "offline",
        selected:
          runsOn?.runtime === "machine" && runsOn.machineId === machine.id,
        value: { machineId: machine.id, runtime: "machine" },
      });
    }
  }
  return options;
};

const NO_KEY_TEXT = "no Anthropic API key";

/** Whether a draft error says the workspace has no Anthropic API key. */
export const isNoKeyError = (message: string): boolean =>
  message.includes(NO_KEY_TEXT);

/** The session key that keeps the description across a trip to Settings. */
export const DESCRIPTION_KEY = "hm:agent-builder-description";

type DescriptionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The saved description, or "" when none is saved or storage cannot be read. */
export const loadDescription = (storage: DescriptionStorage): string => {
  try {
    return storage.getItem(DESCRIPTION_KEY) ?? "";
  } catch {
    return "";
  }
};

/** Saves the description. Empty text removes the key. Storage failures are ignored. */
export const saveDescription = (
  storage: DescriptionStorage,
  text: string
): void => {
  try {
    if (text === "") {
      storage.removeItem(DESCRIPTION_KEY);
    } else {
      storage.setItem(DESCRIPTION_KEY, text);
    }
  } catch {
    // Storage is unavailable, so the description is not kept.
  }
};

/** Forgets the saved description. Storage failures are ignored. */
export const clearDescription = (storage: DescriptionStorage): void => {
  try {
    storage.removeItem(DESCRIPTION_KEY);
  } catch {
    // Storage is unavailable, so there is nothing to forget.
  }
};
