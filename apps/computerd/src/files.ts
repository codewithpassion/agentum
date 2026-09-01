/**
 * The four file operations. Their semantics - and their wording - match
 * `AgentComputer` in `apps/web/src/modules/computer/durable-object.ts`, so an
 * agent moved from the Cloudflare backend to a container gets the same answers
 * from the same mistakes.
 */

import { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { byteLength, MAX_READ_BYTES, resolveInRoot } from "./paths";
import type {
  DirEntry,
  ListResult,
  ReadResult,
  WriteEncoding,
  WriteResult,
} from "./protocol";

/** "Is it there?" is a caught rejection: `stat` throws on a missing path. */
const statOrNull = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
};

const readLimit = (raw: unknown): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : MAX_READ_BYTES;

export const readFileOp = async (
  root: string,
  path: unknown,
  maxBytes: unknown
): Promise<ReadResult> => {
  const target = await resolveInRoot(root, path);
  if (!target.ok) {
    return target;
  }

  const stat = await statOrNull(target.abs);
  if (!stat) {
    return { ok: false, reason: `No such file: ${target.path}` };
  }
  if (stat.isDirectory()) {
    return { ok: false, reason: `${target.path} is a directory.` };
  }

  const limit = readLimit(maxBytes);
  if (stat.size > limit) {
    return {
      ok: false,
      reason: `${target.path} is ${stat.size} bytes, over the ${limit} byte read limit.`,
    };
  }
  return {
    content: await Bun.file(target.abs).text(),
    ok: true,
    size: stat.size,
  };
};

const decodeContent = (
  content: unknown,
  encoding: unknown
): { data: string | Uint8Array } | { reason: string } => {
  if (typeof content !== "string") {
    return { reason: "File content must be a string." };
  }
  if (encoding === undefined || encoding === null || encoding === "utf8") {
    return { data: content };
  }
  if (encoding === ("base64" satisfies WriteEncoding)) {
    return { data: new Uint8Array(Buffer.from(content, "base64")) };
  }
  return { reason: 'Encoding must be "utf8" or "base64".' };
};

const sizeOf = (data: string | Uint8Array): number =>
  typeof data === "string" ? byteLength(data) : data.byteLength;

export const writeFileOp = async (
  root: string,
  path: unknown,
  content: unknown,
  encoding: unknown
): Promise<WriteResult> => {
  const target = await resolveInRoot(root, path);
  if (!target.ok) {
    return target;
  }

  const decoded = decodeContent(content, encoding);
  if ("reason" in decoded) {
    return { ok: false, reason: decoded.reason };
  }

  // Writing `/notes/plan.md` into an empty computer has to work, so the
  // intermediate directories are created rather than reported missing.
  await mkdir(dirname(target.abs), { recursive: true });
  const existed = (await statOrNull(target.abs)) !== null;
  await Bun.write(target.abs, decoded.data);
  return { created: !existed, ok: true, size: sizeOf(decoded.data) };
};

/** Replaces the single occurrence of `oldString`; ambiguity is an error, not a guess. */
export const editFileOp = async (
  root: string,
  path: unknown,
  oldString: unknown,
  newString: unknown
): Promise<WriteResult> => {
  const target = await resolveInRoot(root, path);
  if (!target.ok) {
    return target;
  }
  if (typeof oldString !== "string" || oldString.length === 0) {
    return { ok: false, reason: "old_string is required." };
  }
  if (typeof newString !== "string") {
    return { ok: false, reason: "new_string must be a string." };
  }

  const stat = await statOrNull(target.abs);
  if (!stat || stat.isDirectory()) {
    return { ok: false, reason: `No such file: ${target.path}` };
  }

  const before = await Bun.file(target.abs).text();
  const occurrences = before.split(oldString).length - 1;
  if (occurrences === 0) {
    return { ok: false, reason: `old_string was not found in ${target.path}.` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `old_string appears ${occurrences} times in ${target.path}; include enough surrounding context to make it unique.`,
    };
  }

  const after = before.replace(oldString, newString);
  await Bun.write(target.abs, after);
  return { created: false, ok: true, size: byteLength(after) };
};

export const listDirOp = async (
  root: string,
  path: unknown
): Promise<ListResult> => {
  const target = await resolveInRoot(root, path);
  if (!target.ok) {
    return target;
  }

  const stat = await statOrNull(target.abs);
  if (!stat) {
    return { ok: false, reason: `No such directory: ${target.path}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `${target.path} is a file, not a directory.` };
  }

  const names = await readdir(target.abs);
  // `lstat` describes the entry itself: a symlink is a link of its own size,
  // not whatever it points at, which may not even be readable.
  const entries: DirEntry[] = await Promise.all(
    names.map(async (name): Promise<DirEntry> => {
      const entry = await statOrNull(join(target.abs, name));
      return {
        directory: entry?.isDirectory() ?? false,
        name,
        size: entry?.size ?? 0,
      };
    })
  );
  return { entries, ok: true };
};
