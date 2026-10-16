// Copies an agent's skills from the Worker into the work directory, under
// `.claude/skills/`. The whole list is checked and every path validated before
// the first download, and every file is downloaded before the first write, so
// a refused path, a failed download or an abort leaves the directory untouched.

import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import type { SkillsApi } from "./skills-api.ts";
import type { WorkFiles } from "./work-files.ts";

/** Where skills are written, relative to the work directory. */
export const SKILLS_DIR = ".claude/skills";

const BACKSLASH = "\\";
const CONTROL_CHARACTER = /\p{Cc}/u;
const REFUSED_SEGMENTS = new Set(["", ".", ".."]);
const MIN_SEGMENTS = 2;

/** Why `path` may not name a skill file, or undefined when it may. */
const refusalReason = (path: string): string | undefined => {
  if (path === "") {
    return "the path is empty";
  }
  if (path.startsWith("/")) {
    return "the path is absolute";
  }
  if (path.includes(BACKSLASH)) {
    return "the path contains a backslash";
  }
  if (CONTROL_CHARACTER.test(path)) {
    return "the path contains a control character";
  }
  const segments = path.split("/");
  if (segments.length < MIN_SEGMENTS) {
    return "the path has fewer than two segments";
  }
  if (segments.some((segment) => REFUSED_SEGMENTS.has(segment))) {
    return "a segment is empty, '.' or '..'";
  }
};

/** Throws naming `path` when it may not be written. */
const assertSafePath = (path: string): void => {
  const reason = refusalReason(path);
  if (reason !== undefined) {
    throw new Error(`Refused skill path ${JSON.stringify(path)}: ${reason}`);
  }
};

export interface SyncSkillsOptions {
  api: SkillsApi;
  files: WorkFiles;
  signal?: AbortSignal;
}

/**
 * Downloads the skill files the Worker lists and writes them under
 * `.claude/skills/`. Resolves with the number of files written. Rejects when
 * the list is over the caps, a path is refused, a download or write fails, or
 * the signal aborts.
 */
export const syncSkills = async (
  options: SyncSkillsOptions
): Promise<number> => {
  const { api, files, signal } = options;
  signal?.throwIfAborted();
  const listed = await api.list(signal);
  if (listed.length > SKILLS_MAX_FILES) {
    throw new Error(
      `Skills hold ${listed.length} files, more than the ${SKILLS_MAX_FILES} allowed`
    );
  }
  const totalBytes = listed.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > SKILLS_MAX_BYTES) {
    throw new Error(
      `Skills hold ${totalBytes} bytes, more than the ${SKILLS_MAX_BYTES} allowed`
    );
  }
  for (const file of listed) {
    assertSafePath(file.path);
  }

  const downloaded: { bytes: Uint8Array; path: string }[] = [];
  for (const file of listed) {
    signal?.throwIfAborted();
    // biome-ignore lint/performance/noAwaitInLoops: files are downloaded one at a time, so a slow link is not asked for 5 MB several times at once.
    const bytes = await api.file(file.path, signal);
    downloaded.push({ bytes, path: file.path });
  }

  for (const file of downloaded) {
    signal?.throwIfAborted();
    // biome-ignore lint/performance/noAwaitInLoops: files are written one at a time, in the order the Worker listed them.
    await files.write(`${SKILLS_DIR}/${file.path}`, file.bytes);
  }
  return downloaded.length;
};
