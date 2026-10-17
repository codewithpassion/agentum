/**
 * Reads the skills still kept in the workspace library, for the one-off
 * migration into the store: `skills/<agentId>/<name>/` (an agent's own) and
 * `skills/_shared/<name>/` (every agent's). A folder that breaks a rule is
 * skipped and reported, never half imported.
 */
import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { isServiceError, ServiceError } from "../errors.ts";
import type { LibraryEntry, LibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import {
  assertSkillName,
  assertTree,
  type PlannedFile,
  sha256Hex,
} from "./tree.ts";

export type SkillsSourceLibrary = Pick<LibraryService, "list" | "read">;

const SKILLS_DIR = "skills";
const SHARED_DIR = "_shared";

/** One library skill folder, ready to become version 1. */
export interface LibrarySkill {
  files: PlannedFile[];
  name: string;
  /** The agent that owned the folder, null for `_shared`. */
  ownerAgentId: string | null;
}

export interface SkippedSkill {
  path: string;
  reason: string;
}

export interface LibrarySnapshot {
  /** Folder names each agent had, readable or not. An own folder hides the shared one of its name. */
  ownFolders: Map<string, Set<string>>;
  skills: LibrarySkill[];
  skipped: SkippedSkill[];
}

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const listOrEmpty = async (
  library: SkillsSourceLibrary,
  principal: Principal,
  dir: string
): Promise<LibraryEntry[]> => {
  try {
    return await library.list(principal, dir);
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return [];
    }
    throw error;
  }
};

const tooBig = () =>
  new ServiceError(
    "invalid",
    `Skills are limited to ${SKILLS_MAX_FILES} files and 5 MB`
  );

/** The files under `root`, one folder level at a time. Stops at the caps, before any bytes are read. */
const filesUnder = async (
  library: SkillsSourceLibrary,
  principal: Principal,
  root: string
): Promise<LibraryEntry[]> => {
  const files: LibraryEntry[] = [];
  let bytes = 0;
  let level = [root];
  while (level.length > 0) {
    // biome-ignore lint/performance/noAwaitInLoops: one folder level at a time keeps the cap exact
    const listings = await Promise.all(
      level.map((dir) => library.list(principal, dir))
    );
    level = [];
    for (const entry of listings.flat()) {
      if (entry.kind === "dir") {
        level.push(entry.path);
        continue;
      }
      files.push(entry);
      bytes += entry.size;
      if (files.length > SKILLS_MAX_FILES || bytes > SKILLS_MAX_BYTES) {
        throw tooBig();
      }
    }
  }
  return files;
};

const readSkill = async (
  library: SkillsSourceLibrary,
  principal: Principal,
  folderPath: string,
  name: string,
  ownerAgentId: string | null
): Promise<LibrarySkill> => {
  assertSkillName(name);
  const entries = await filesUnder(library, principal, folderPath);
  const files = await Promise.all(
    entries.map(async (entry): Promise<PlannedFile> => {
      const { bytes } = await library.read(principal, entry.path);
      return {
        bytes,
        executable: false,
        hash: await sha256Hex(bytes),
        path: entry.path.slice(folderPath.length + 1),
        size: bytes.byteLength,
      };
    })
  );
  assertTree(name, files);
  return { files, name, ownerAgentId };
};

/** Why a folder was skipped. A service error has a message for the person, anything else is a bug and goes up. */
const reasonOf = (error: unknown): string => {
  if (isServiceError(error)) {
    return error.code === "not_found" ? "A file is missing" : error.message;
  }
  throw error;
};

/** Every skill folder of the library. Folders of an id that is not one of `agentIds` are ignored. */
export const readLibrarySkills = async (
  library: SkillsSourceLibrary,
  principal: Principal,
  agentIds: ReadonlySet<string>
): Promise<LibrarySnapshot> => {
  const snapshot: LibrarySnapshot = {
    ownFolders: new Map(),
    skills: [],
    skipped: [],
  };
  const roots = (await listOrEmpty(library, principal, SKILLS_DIR)).filter(
    (entry) => entry.kind === "dir"
  );
  for (const root of roots) {
    const owner = lastSegment(root.path);
    const ownerAgentId = owner === SHARED_DIR ? null : owner;
    if (ownerAgentId !== null && !agentIds.has(ownerAgentId)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one root at a time keeps the reads bounded
    const folders = (await listOrEmpty(library, principal, root.path)).filter(
      (entry) => entry.kind === "dir"
    );
    if (ownerAgentId !== null) {
      snapshot.ownFolders.set(
        ownerAgentId,
        new Set(folders.map((folder) => lastSegment(folder.path)))
      );
    }
    const results = await Promise.all(
      folders.map(async (folder) => {
        try {
          return await readSkill(
            library,
            principal,
            folder.path,
            lastSegment(folder.path),
            ownerAgentId
          );
        } catch (error) {
          return { path: folder.path, reason: reasonOf(error) };
        }
      })
    );
    for (const result of results) {
      if ("reason" in result) {
        snapshot.skipped.push(result);
      } else {
        snapshot.skills.push(result);
      }
    }
  }
  return snapshot;
};
