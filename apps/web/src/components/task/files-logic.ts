// The pure helpers behind the task view's Files panel: a path shown relative
// to the task folder, the tag of an edit made outside it, and the file time.

import type { LibraryVersionOp } from "@repo/db/shared";

/** A path with the task folder stripped from its front, or the path unchanged when it is not under the folder. */
export const relativeToFolder = (path: string, folder: string): string => {
  const prefix = `${folder}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

export const OUTSIDE_TAGS: Record<LibraryVersionOp, string> = {
  delete: "deleted",
  move: "moved",
  restore: "restored",
  write: "edited",
};

/** The tag of an edit made outside the task folder, such as "edited · v12". */
export const outsideTag = (op: LibraryVersionOp, version: number): string =>
  `${OUTSIDE_TAGS[op]} · v${version}`;

/** The HH:MM part of a stored UTC ISO time, such as "10:01" for "2026-10-27T10:01:30.000Z". */
export const fileTime = (iso: string): string => iso.slice(11, 16);

/** The entries of kind "file", in their given order. */
export const fileEntries = <T extends { kind: "file" | "dir" }>(
  entries: readonly T[]
): T[] => entries.filter((entry) => entry.kind === "file");
