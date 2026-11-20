// Reads and writes an agent's memory files through the library service. The
// bytes are the codec's (`codec.ts`); this file only moves them. Every write is
// one library call that also carries the caller's `memory_changes` statements.
import type { Statement } from "@repo/db/atomic";
import { MEMORY_NOTE_KINDS, type MemoryNote } from "@repo/db/shared";
import { invalid, isServiceError } from "../errors.ts";
import { memoryFolderOf } from "../library/memory-paths.ts";
import type { LibraryService } from "../library.ts";
import type { Principal } from "../workspaces.ts";
import {
  apply,
  MemoryCodecError,
  type MemoryFileChange,
  type MemoryFiles,
  type MemoryProblem,
  parseMemoryFile,
} from "./codec.ts";

const INDEX = "index.md";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type MemoryLibrary = Pick<
  LibraryService,
  "read" | "readVersion" | "versions" | "writeMemoryFiles"
>;

/** What the dream needs on top: listing a folder, to find every person's private file. */
export type DreamMemoryLibrary = MemoryLibrary & Pick<LibraryService, "list">;

export interface LoadedMemory {
  /** The etag of every file that exists, `index.md` included. Paths are relative to the memory folder. */
  etags: Record<string, string>;
  /** Text of the note files that parse, for `apply`. `index.md` is left out. */
  files: MemoryFiles;
  /** The notes in those files, shared files first. */
  notes: MemoryNote[];
  /** The note files that do not parse, with the first problem in each. */
  problems: Record<string, MemoryProblem>;
  /** Text of every file that exists, `index.md` included. */
  texts: Record<string, string>;
}

/** The file a note lives in, relative to the memory folder. */
export const pathOfNote = (note: {
  kind: string;
  userScope: string | null;
}): string =>
  note.userScope === null ? `${note.kind}.md` : `private/${note.userScope}.md`;

const readText = async (
  library: MemoryLibrary,
  principal: Principal,
  folder: string,
  path: string
): Promise<{ etag: string; text: string } | null> => {
  try {
    const { bytes, entry } = await library.read(principal, `${folder}/${path}`);
    return { etag: entry.etag ?? "", text: decoder.decode(bytes) };
  } catch (error) {
    if (isServiceError(error) && error.code === "not_found") {
      return null;
    }
    throw error;
  }
};

const loadPaths = async (
  library: MemoryLibrary,
  principal: Principal,
  slug: string,
  paths: readonly string[]
): Promise<LoadedMemory> => {
  const folder = memoryFolderOf(slug);
  const found = await Promise.all(
    paths.map((path) => readText(library, principal, folder, path))
  );
  const loaded: LoadedMemory = {
    etags: {},
    files: {},
    notes: [],
    problems: {},
    texts: {},
  };
  for (const [index, path] of paths.entries()) {
    const file = found[index];
    if (!file) {
      continue;
    }
    loaded.etags[path] = file.etag;
    loaded.texts[path] = file.text;
    if (path === INDEX) {
      continue;
    }
    const parsed = parseMemoryFile(path, file.text);
    if (parsed.ok) {
      loaded.files[path] = file.text;
      loaded.notes.push(...parsed.notes);
    } else if (parsed.problems[0]) {
      loaded.problems[path] = parsed.problems[0];
    }
  }
  return loaded;
};

/**
 * The files the principal may see: the four shared kinds, the index, and the
 * private file of `userScope` when there is one. A file that does not parse is
 * reported in `problems` and left out of `files` and `notes`.
 */
export const loadMemory = (
  library: MemoryLibrary,
  principal: Principal,
  slug: string,
  userScope: string | null
): Promise<LoadedMemory> =>
  loadPaths(library, principal, slug, [
    ...MEMORY_NOTE_KINDS.map((kind) => `${kind}.md`),
    ...(userScope === null ? [] : [`private/${userScope}.md`]),
    INDEX,
  ]);

const PRIVATE_FOLDER = "private";
/** A person's private note file. Anything else in the folder is not memory. */
const PRIVATE_NOTE_FILE = /^user_[A-Za-z0-9]+\.md$/;

/**
 * Every memory file there is: the shared ones, the index and each person's
 * private file. Only the dream may read this much, through a principal that
 * carries `dream`.
 */
export const loadEveryMemoryFile = async (
  library: DreamMemoryLibrary,
  principal: Principal,
  slug: string
): Promise<LoadedMemory> => {
  let privateFiles: string[] = [];
  try {
    const entries = await library.list(
      principal,
      `${memoryFolderOf(slug)}/${PRIVATE_FOLDER}`
    );
    privateFiles = entries
      .map((entry) => entry.path.split("/").pop() ?? "")
      .filter((name) => PRIVATE_NOTE_FILE.test(name))
      .map((name) => `${PRIVATE_FOLDER}/${name}`);
  } catch (error) {
    if (!(isServiceError(error) && error.code === "not_found")) {
      throw error;
    }
  }
  return await loadPaths(library, principal, slug, [
    ...MEMORY_NOTE_KINDS.map((kind) => `${kind}.md`),
    ...privateFiles,
    INDEX,
  ]);
};

/** Why a file is refused, in words a person can act on. */
export const describeProblem = (path: string, problem: MemoryProblem) =>
  `${path} does not parse (line ${problem.line}: ${problem.message}). Fix the file in the library, then try again.`;

/** The note with this id among the loaded notes, found by id alone. */
export const findNote = (
  loaded: LoadedMemory,
  noteId: string
): MemoryNote | undefined => {
  const key = noteId.toUpperCase();
  return loaded.notes.find((note) => note.id.toUpperCase() === key);
};

/**
 * Applies one change to the loaded files and writes every file it changed, plus
 * the caller's statements, in one library call. `statements` gets the id of the
 * library version of the note's own file. Throws `invalid` when the change
 * alters nothing. A stale etag surfaces as the library's `conflict`.
 */
export const commitChange = async ({
  change,
  library,
  loaded,
  notePath,
  principal,
  slug,
  statements,
}: {
  change: MemoryFileChange;
  library: MemoryLibrary;
  loaded: LoadedMemory;
  notePath: string;
  principal: Principal;
  slug: string;
  statements: (libraryVersionId: string) => Statement[];
}): Promise<void> => {
  // A file that does not parse is never overwritten, so nothing goes into it.
  const problem = loaded.problems[notePath];
  if (problem) {
    throw invalid(describeProblem(notePath, problem));
  }
  let next: MemoryFiles;
  try {
    next = apply(loaded.files, change);
  } catch (error) {
    if (error instanceof MemoryCodecError) {
      throw invalid(error.message);
    }
    throw error;
  }
  const changed = Object.keys(next).filter(
    (path) => next[path] !== loaded.texts[path]
  );
  if (changed.length === 0) {
    throw invalid("That note already says that");
  }
  const folder = memoryFolderOf(slug);
  await library.writeMemoryFiles(
    principal,
    changed.map((path) => ({
      bytes: encoder.encode(next[path]),
      ifEtag: loaded.etags[path],
      path: `${folder}/${path}`,
    })),
    (versions) => {
      const version = versions[changed.indexOf(notePath)];
      if (!version) {
        throw invalid("The note's file was not written");
      }
      return statements(version.id);
    }
  );
};

// A dream writes several files and rows in one call, and puts them back.
// Everything it writes lands together: the files, the library versions and the
// caller's rows (`memory_changes`, the run), so a dream that fails leaves memory
// as it was. It lives here because this module is the only caller of the
// library's memory write (`scripts/memory-sole-writer.test.ts`).
export interface Written {
  /** The latest version of each file that existed before this write. Undo puts them back. */
  baseVersion: string[];
  /** The last version this write made. */
  resultVersion: string;
  /** The version this write made of each file, by path relative to the memory folder. */
  versionByPath: Map<string, string>;
}

/** The files whose bytes differ from what was loaded. */
export const changedPaths = (
  loaded: LoadedMemory,
  next: Readonly<MemoryFiles>
): string[] =>
  Object.keys(next).filter((path) => next[path] !== loaded.texts[path]);

/**
 * Writes every file of `next` that differs from `loaded`, each guarded by the
 * etag it was loaded with. `statements` runs once the versions exist, and its
 * statements commit with the files. Throws `invalid` when nothing differs and
 * the library's `conflict` when a file changed since it was loaded.
 */
export const commitFiles = async ({
  library,
  loaded,
  next,
  principal,
  slug,
  statements,
}: {
  library: Pick<MemoryLibrary, "versions" | "writeMemoryFiles">;
  loaded: LoadedMemory;
  next: Readonly<MemoryFiles>;
  principal: Principal;
  slug: string;
  statements: (written: Written) => Statement[];
}): Promise<Written> => {
  const paths = changedPaths(loaded, next);
  if (paths.length === 0) {
    throw invalid("The dream changed nothing");
  }
  const folder = memoryFolderOf(slug);
  const base = await Promise.all(
    paths.map(async (path) =>
      path in loaded.texts
        ? ((await library.versions(principal, `${folder}/${path}`))[0]?.id ??
          null)
        : null
    )
  );
  const baseVersion = base.flatMap((id) => id ?? []);
  let written: Written | null = null;
  await library.writeMemoryFiles(
    principal,
    paths.map((path) => ({
      bytes: encoder.encode(next[path]),
      ifEtag: loaded.etags[path],
      path: `${folder}/${path}`,
    })),
    (versions) => {
      const versionByPath = new Map(
        paths.map((path, index) => [path, versions[index]?.id ?? ""] as const)
      );
      const resultVersion = versions.at(-1)?.id ?? "";
      written = { baseVersion, resultVersion, versionByPath };
      return statements(written);
    }
  );
  if (!written) {
    throw invalid("The dream's files were not written");
  }
  return written;
};

/** The latest library version of each of the memory files that exist, by path relative to the memory folder. */
export const latestVersionIds = async (
  library: Pick<MemoryLibrary, "versions">,
  principal: Principal,
  slug: string,
  paths: readonly string[]
): Promise<string[]> => {
  const folder = memoryFolderOf(slug);
  const latest = await Promise.all(
    paths.map(
      async (path) =>
        (await library.versions(principal, `${folder}/${path}`))[0]?.id ?? null
    )
  );
  return latest.flatMap((id) => id ?? []);
};
