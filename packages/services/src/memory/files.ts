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

/**
 * The files the principal may see: the four shared kinds, the index, and the
 * private file of `userScope` when there is one. A file that does not parse is
 * reported in `problems` and left out of `files` and `notes`.
 */
export const loadMemory = async (
  library: MemoryLibrary,
  principal: Principal,
  slug: string,
  userScope: string | null
): Promise<LoadedMemory> => {
  const folder = memoryFolderOf(slug);
  const paths = [
    ...MEMORY_NOTE_KINDS.map((kind) => `${kind}.md`),
    ...(userScope === null ? [] : [`private/${userScope}.md`]),
    INDEX,
  ];
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
