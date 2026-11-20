import type { MemoryChange } from "@repo/db/shared";
import { parseMemoryFile } from "@repo/services/memory/codec";
import { getTrpc } from "#/integrations/trpc/client";

export interface DreamChangeView {
  after: string | null;
  before: string | null;
  change: MemoryChange;
}

interface VersionRead {
  /** Null for a delete tombstone. */
  text: string | null;
  version: { id: string; path: string };
}

/** The folder a library path of a memory file starts with. The codec wants the path inside it. */
const MEMORY_FOLDER_PREFIX = /^agents\/[^/]+\/memory\//;

/** The text of the note with this id in a memory file, or null when the file is malformed or has no such note. `path` is the library path, such as `agents/scout/memory/people.md`. */
export function noteTextIn(
  path: string,
  fileText: string,
  noteId: string
): string | null {
  const parsed = parseMemoryFile(
    path.replace(MEMORY_FOLDER_PREFIX, ""),
    fileText
  );
  if (!parsed.ok) {
    return null;
  }
  const wanted = noteId.toLowerCase();
  const note = parsed.notes.find((item) => item.id.toLowerCase() === wanted);
  return note?.text ?? null;
}

/** The text on each side of a change. Add has no before, forget has no after. */
export function sidesOf(
  change: MemoryChange,
  before: string | null
): { after: string | null; before: string | null } {
  if (change.action === "add") {
    return { after: change.text, before: null };
  }
  if (change.action === "forget") {
    return { after: null, before: change.text };
  }
  return { after: change.text, before };
}

/** Reads the note text as it stood before this change, from the library version it wrote. */
async function beforeText(
  change: MemoryChange,
  readVersion: (versionId: string) => Promise<VersionRead | null>,
  historyOf: (path: string) => Promise<readonly { id: string }[] | null>
): Promise<string | null> {
  const isEditOrMerge = change.action === "edit" || change.action === "merge";
  if (!(isEditOrMerge && change.libraryVersionId)) {
    return null;
  }
  const current = await readVersion(change.libraryVersionId);
  if (!current) {
    return null;
  }
  const history = await historyOf(current.version.path);
  if (!history) {
    return null;
  }
  const index = history.findIndex((entry) => entry.id === current.version.id);
  const previous = index === -1 ? undefined : history[index + 1];
  if (!previous) {
    return null;
  }
  const earlier = await readVersion(previous.id);
  if (!earlier) {
    return null;
  }
  return earlier.text === null
    ? null
    : noteTextIn(earlier.version.path, earlier.text, change.noteId);
}

/** The changes of one dream run, in the order the server returns them, with before and after text. A failed version read leaves that side null instead of failing the load. */
export async function loadDreamChanges(
  dreamRunId: string
): Promise<DreamChangeView[]> {
  const trpc = getTrpc();
  const changes = await trpc.dream.changes.query({ dreamRunId });

  // One read per version and one history per path inside this call.
  const versionReads = new Map<string, Promise<VersionRead | null>>();
  const histories = new Map<
    string,
    Promise<readonly { id: string }[] | null>
  >();
  const readVersion = (versionId: string): Promise<VersionRead | null> => {
    const known = versionReads.get(versionId);
    if (known) {
      return known;
    }
    const read = trpc.library.readVersion
      .query({ versionId })
      .catch((): null => null);
    versionReads.set(versionId, read);
    return read;
  };
  const historyOf = (path: string) => {
    const known = histories.get(path);
    if (known) {
      return known;
    }
    const history = trpc.library.versions
      .query({ path })
      .catch((): null => null);
    histories.set(path, history);
    return history;
  };

  return await Promise.all(
    changes.map(async (change) => {
      const before = await beforeText(change, readVersion, historyOf);
      return { change, ...sidesOf(change, before) };
    })
  );
}
