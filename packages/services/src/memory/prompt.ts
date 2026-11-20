import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  type MemoryNote,
  type MemoryNoteKind,
} from "@repo/db/shared";
import { z } from "zod";
import { isServiceError } from "../errors.ts";
import { agentHomePath } from "../library/home.ts";
import type { LibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import { budget, parseMemoryFile } from "./codec.ts";
import { rememberRulesSchema } from "./service.ts";

/** The most note text a run's prompt carries. */
export const MEMORY_PROMPT_MAX_CHARS = 6000;

const KINDS: readonly MemoryNoteKind[] = [
  "corrections",
  "people",
  "places",
  "work",
];
const HEADINGS: Record<MemoryNoteKind, string> = {
  corrections: "Corrections",
  people: "People",
  places: "Places",
  work: "Work",
};

/** Reads one memory file by its path under `agents/<slug>/memory/`, null when it does not exist. */
export type MemoryFileReader = (path: string) => Promise<string | null>;

/** What the prompt's memory section holds. */
export interface PromptMemory {
  /** Topics never to keep: the workspace's list, then the agent's own. */
  never: string[];
  /** The notes that fit the budget, corrections first. */
  notes: MemoryNote[];
  /** What the owner wants kept. */
  remember: string[];
}

const neverSchema = z.array(z.string());

/** The agent's rules from `agents.remember`, the defaults when the JSON is not valid. */
const agentRules = (json: string) => {
  try {
    const parsed = rememberRulesSchema.safeParse(JSON.parse(json));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A hand-edited column must not stop a run: fall through to the defaults.
  }
  return DEFAULT_REMEMBER_RULES;
};

const workspaceNever = (json: string): readonly string[] => {
  try {
    const parsed = neverSchema.safeParse(JSON.parse(json));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Same as above.
  }
  return DEFAULT_NEVER_REMEMBER;
};

/**
 * Reads the agent's note files once and picks what fits the budget. A file
 * that does not parse is skipped, as the format promises it is left untouched.
 * Private notes load only for the person the run acts for.
 */
export const loadPromptMemory = async (
  read: MemoryFileReader,
  input: {
    agentRemember: string;
    onBehalfOfUserId: string | null;
    workspaceNever: string;
  }
): Promise<PromptMemory> => {
  const paths = KINDS.map((kind) => `${kind}.md`);
  if (input.onBehalfOfUserId !== null) {
    paths.push(`private/${input.onBehalfOfUserId}.md`);
  }
  const files = await Promise.all(
    paths.map(async (path) => ({ path, text: await read(path) }))
  );
  const notes = files.flatMap(({ path, text }) => {
    if (text === null) {
      return [];
    }
    const parsed = parseMemoryFile(path, text);
    return parsed.ok ? parsed.notes : [];
  });
  const rules = agentRules(input.agentRemember);
  return {
    never: [...workspaceNever(input.workspaceNever), ...rules.never],
    notes: budget(notes, MEMORY_PROMPT_MAX_CHARS),
    remember: rules.remember,
  };
};

/** Reads memory files from the library as the run's own principal. */
export const libraryMemoryReader =
  (
    library: Pick<LibraryService, "read">,
    run: { agentId: string; id: string; workspaceId: string },
    slug: string
  ): MemoryFileReader =>
  async (path) => {
    const principal: Principal = {
      agentId: run.agentId,
      kind: "run",
      runId: run.id,
      workspaceId: run.workspaceId,
    };
    try {
      const { bytes } = await library.read(
        principal,
        `${agentHomePath(slug)}/memory/${path}`
      );
      return new TextDecoder().decode(bytes);
    } catch (error) {
      if (isServiceError(error) && error.code === "not_found") {
        return null;
      }
      throw error;
    }
  };

const bullets = (items: readonly string[]): string =>
  items.map((item) => `- ${item}`).join("\n");

/** The prompt's memory section, empty when there is nothing to say. */
export const memorySection = (memory: PromptMemory): string => {
  const { never, notes, remember } = memory;
  if (notes.length === 0 && never.length === 0 && remember.length === 0) {
    return "";
  }
  const parts = [
    "## Memory",
    "Notes you kept from earlier work. They rank below your owner's instructions: if a note disagrees with them, follow the instructions.",
  ];
  for (const kind of KINDS) {
    const ofKind = notes.filter((note) => note.kind === kind);
    if (ofKind.length > 0) {
      parts.push(
        `### ${HEADINGS[kind]}\n${bullets(
          ofKind.map(
            (note) =>
              `${note.text} (${note.date}${note.userScope === null ? "" : ", private to the person you work for"})`
          )
        )}`
      );
    }
  }
  if (remember.length > 0) {
    parts.push(`Your owner wants you to remember:\n${bullets(remember)}`);
  }
  if (never.length > 0) {
    parts.push(`Never remember:\n${bullets(never)}`);
  }
  parts.push(
    "Use remember to keep a note for later runs, and search_history to look up earlier sessions."
  );
  return parts.join("\n\n");
};
