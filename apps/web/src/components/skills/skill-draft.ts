// A skill's staged edits, kept in the browser until one commit saves them.
// Pure and immutable: every change returns a new draft.

export interface DraftFile {
  data: string;
  encoding: "text" | "base64";
}

export interface Draft {
  deletes: ReadonlySet<string>;
  writes: ReadonlyMap<string, DraftFile>;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  kind: ChangeKind;
  path: string;
}

export interface CommitInput {
  baseVersion: number;
  deletes: { path: string }[];
  message: string;
  skillId: string;
  writes: { data: string; encoding: "text" | "base64"; path: string }[];
}

const comparePaths = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

export const emptyDraft = (): Draft => ({
  deletes: new Set(),
  writes: new Map(),
});

export const stageWrite = (
  draft: Draft,
  path: string,
  file: DraftFile
): Draft => {
  const writes = new Map(draft.writes);
  writes.set(path, file);
  const deletes = new Set(draft.deletes);
  deletes.delete(path);
  return { deletes, writes };
};

/** Deleting a file added in this draft just drops its write. */
export const stageDelete = (
  draft: Draft,
  path: string,
  basePaths: ReadonlySet<string>
): Draft => {
  const writes = new Map(draft.writes);
  writes.delete(path);
  const deletes = new Set(draft.deletes);
  if (basePaths.has(path)) {
    deletes.add(path);
  }
  return { deletes, writes };
};

/** The files of the draft's tree: the base minus deletes, plus staged new paths. */
export const treePaths = (
  basePaths: ReadonlySet<string>,
  draft: Draft
): string[] => {
  const paths = new Set<string>();
  for (const path of basePaths) {
    if (!draft.deletes.has(path)) {
      paths.add(path);
    }
  }
  for (const path of draft.writes.keys()) {
    paths.add(path);
  }
  return [...paths].sort(comparePaths);
};

export const changes = (
  basePaths: ReadonlySet<string>,
  draft: Draft
): Change[] => {
  const found: Change[] = [];
  for (const path of draft.writes.keys()) {
    found.push({ kind: basePaths.has(path) ? "modified" : "added", path });
  }
  for (const path of draft.deletes) {
    found.push({ kind: "deleted", path });
  }
  return found.sort((a, b) => comparePaths(a.path, b.path));
};

const trailingPadding = (base64: string): number => {
  if (base64.endsWith("==")) {
    return 2;
  }
  return base64.endsWith("=") ? 1 : 0;
};

/** The size in bytes of a staged file. Base64 is decoded by its length, not by decoding it. */
export const draftFileSize = (file: DraftFile): number => {
  if (file.encoding === "text") {
    return new TextEncoder().encode(file.data).byteLength;
  }
  const padding = trailingPadding(file.data);
  return (file.data.length * 3) / 4 - padding;
};

export const toCommitInput = (
  skillId: string,
  baseVersion: number,
  message: string,
  draft: Draft
): CommitInput => {
  const writes = [...draft.writes]
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([path, file]) => ({
      data: file.data,
      encoding: file.encoding,
      path,
    }));
  const deletes = [...draft.deletes]
    .sort(comparePaths)
    .map((path) => ({ path }));
  return {
    baseVersion,
    deletes,
    message: message.trim(),
    skillId,
    writes,
  };
};
