// A team's memory: the same files as an agent's, in `teams/<slug>/memory/`
// (`docs/v4/memory-format.md`). The team dream writes them; every member agent
// reads them at run start after its own notes. A team has no private files:
// the loaders here never ask for one, whoever is reading.
import {
  MEMORY_NOTE_KINDS,
  type MemoryNote,
  type MemoryNoteKind,
} from "@repo/db/shared";
import { isServiceError } from "../errors.ts";
import { teamMemoryFolderOf } from "../library/memory-paths.ts";
import type { LibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import { budget, parseMemoryFile } from "./codec.ts";
import {
  type LoadedMemory,
  loadFolderMemory,
  type MemoryLibrary,
} from "./files.ts";

/** The most team note text a run's prompt carries, across every team the agent is in. */
export const TEAM_PROMPT_MAX_CHARS = 3000;

/** The file the room digest lives in, beside the notes. It is not a note file, so the codec never reads it. */
export const TEAM_DIGEST_FILE = "digest.md";

/** Reads one file under a team's memory folder, `folderPath` being the team's `teams/<slug>`. Null when it does not exist. */
export type TeamMemoryReader = (
  folderPath: string,
  path: string
) => Promise<string | null>;

/** The notes of one team a prompt carries. */
export interface TeamPromptNotes {
  notes: MemoryNote[];
  teamName: string;
}

/** The team a run's agent is in: its name and library folder. */
export interface PromptTeam {
  folderPath: string;
  name: string;
}

const KIND_FILES = MEMORY_NOTE_KINDS.map(
  (kind: MemoryNoteKind) => `${kind}.md`
);

/**
 * The notes of each team that fit the budget left after the teams before it.
 * A file that does not parse is skipped, as for an agent. A team with no notes
 * is left out.
 */
export const loadTeamPromptNotes = async (
  read: TeamMemoryReader,
  teams: readonly PromptTeam[],
  maxChars: number = TEAM_PROMPT_MAX_CHARS
): Promise<TeamPromptNotes[]> => {
  const loaded: TeamPromptNotes[] = [];
  let remaining = maxChars;
  for (const team of teams) {
    // biome-ignore lint/performance/noAwaitInLoops: each team spends what the one before left
    const files = await Promise.all(
      KIND_FILES.map(async (path) => ({
        path,
        text: await read(team.folderPath, path),
      }))
    );
    const notes = files.flatMap(({ path, text }) => {
      if (text === null) {
        return [];
      }
      const parsed = parseMemoryFile(path, text);
      return parsed.ok
        ? parsed.notes.filter((note) => note.userScope === null)
        : [];
    });
    const fitted = budget(notes, remaining);
    remaining -= fitted.reduce((sum, note) => sum + note.text.length, 0);
    if (fitted.length > 0) {
      loaded.push({ notes: fitted, teamName: team.name });
    }
  }
  return loaded;
};

/** Reads team memory files from the library as the run's own principal. A file that cannot be read counts as missing. */
export const libraryTeamMemoryReader =
  (
    library: Pick<LibraryService, "read">,
    run: { agentId: string; id: string; workspaceId: string }
  ): TeamMemoryReader =>
  async (folderPath, path) => {
    const principal: Principal = {
      agentId: run.agentId,
      kind: "run",
      runId: run.id,
      workspaceId: run.workspaceId,
    };
    try {
      const { bytes } = await library.read(
        principal,
        `${teamMemoryFolderOf(folderPath)}/${path}`
      );
      return new TextDecoder().decode(bytes);
    } catch (error) {
      // A failed read must not fail the launch: the run starts without that file.
      if (!(isServiceError(error) && error.code === "not_found")) {
        console.error(
          `Reading team memory file ${path} for run ${run.id} failed: ${error instanceof Error ? error.name : "unknown error"}`
        );
      }
      return null;
    }
  };

/** Every shared note of a team's folder, and the files that did not parse. */
export const loadTeamFolder = (
  library: MemoryLibrary,
  principal: Principal,
  folderPath: string
): Promise<LoadedMemory> =>
  loadFolderMemory(library, principal, teamMemoryFolderOf(folderPath));

/** The digest file as it is now: its text and etag, or null when the file does not exist. */
export const readTeamDigestFile = async (
  library: Pick<LibraryService, "read">,
  principal: Principal,
  folderPath: string
): Promise<{ etag: string; text: string } | null> => {
  try {
    const { bytes, entry } = await library.read(
      principal,
      `${teamMemoryFolderOf(folderPath)}/${TEAM_DIGEST_FILE}`
    );
    return { etag: entry.etag ?? "", text: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return null;
    }
    throw error;
  }
};

/** The room digest the last team dream wrote, or null when there is none or the file is blank. */
export const readTeamDigest = async (
  library: Pick<LibraryService, "read">,
  principal: Principal,
  folderPath: string
): Promise<string | null> => {
  const file = await readTeamDigestFile(library, principal, folderPath);
  if (file === null) {
    return null;
  }
  const text = file.text.trim();
  return text === "" ? null : text;
};
