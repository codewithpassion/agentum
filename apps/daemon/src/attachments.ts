// Outbound file delivery: the `[ATTACHMENT:path]` marker convention.
//
// The agent hands files back to the chat by writing `[ATTACHMENT:/abs/path]`,
// or a path relative to the work directory, in its reply. Skills rely on this
// exact syntax, so the regex below is the contract. This module is pure text
// and filesystem policy. It does not log; callers decide what to report.

import { realpathSync, type Stats, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ATTACHMENT_MARKER_RE,
  stripAttachmentMarkers,
} from "@repo/protocol/attachments";
import { file as bunFile } from "bun";

/**
 * The server's per-file cap. Mirrors MAX_FILE_BYTES in packages/db/src/shared.ts,
 * which the daemon does not import.
 */
export const MAX_OUTBOUND_BYTES = 50 * 1024 * 1024;

const FALLBACK_MIME = "application/octet-stream";
const MISSING_REASONS = new Set<RejectedFile["reason"]>([
  "missing",
  "not_a_file",
]);

export interface ExtractedMarkers {
  /** Marker paths in order of first appearance, trimmed and de-duplicated. */
  paths: string[];
  /** `text` with every marker removed and leftover blank runs collapsed. */
  text: string;
}

/**
 * Pull `[ATTACHMENT:...]` markers out of `text`. Paths may contain spaces:
 * anything up to the closing `]` is the path.
 */
export const extractAttachmentMarkers = (text: string): ExtractedMarkers => {
  if (!text.includes("[ATTACHMENT:")) {
    return { paths: [], text };
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_MARKER_RE)) {
    const path = (match[1] ?? "").trim();
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return { paths, text: stripAttachmentMarkers(text) };
};

export interface OutboundPolicy {
  /** Largest file in bytes that may be attached. */
  maxBytes: number;
  /** Base for relative marker paths, and the only directory files may come from. */
  workDir: string;
}

export interface OutboundFile {
  mime: string;
  name: string;
  /** Real path, with symlinks resolved. */
  path: string;
  size: number;
}

export interface RejectedFile {
  name: string;
  path: string;
  reason: "missing" | "not_a_file" | "outside_root" | "too_large";
}

export interface ResolvedOutbound {
  files: OutboundFile[];
  rejected: RejectedFile[];
}

type Inspection = { file: OutboundFile } | { reason: RejectedFile["reason"] };

const realpathOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

export const isWithin = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
};

export const mimeOf = (realPath: string): string => {
  const type = bunFile(realPath).type.split(";")[0]?.trim() ?? "";
  return type === "" ? FALLBACK_MIME : type;
};

const inspect = (
  abs: string,
  root: string | null,
  maxBytes: number
): Inspection => {
  if (root === null) {
    return { reason: "outside_root" };
  }
  let stat: Stats;
  let real: string;
  try {
    stat = statSync(abs);
    real = realpathSync(abs);
  } catch {
    return { reason: "missing" };
  }
  if (!stat.isFile()) {
    return { reason: "not_a_file" };
  }
  if (!isWithin(root, real)) {
    return { reason: "outside_root" };
  }
  if (stat.size > maxBytes) {
    return { reason: "too_large" };
  }
  return {
    file: {
      mime: mimeOf(real),
      name: basename(abs),
      path: real,
      size: stat.size,
    },
  };
};

/**
 * Turn marker paths into uploadable files. Each path must resolve (after
 * symlinks) to a regular file inside `workDir` and be at most `maxBytes`.
 * Rejected paths come back with a reason so the caller can mention them.
 */
export const resolveOutboundFiles = (
  paths: string[],
  policy: OutboundPolicy
): ResolvedOutbound => {
  const root = realpathOrNull(resolve(policy.workDir));
  const files: OutboundFile[] = [];
  const rejected: RejectedFile[] = [];
  for (const raw of paths) {
    const abs = isAbsolute(raw) ? raw : resolve(policy.workDir, raw);
    const outcome = inspect(abs, root, policy.maxBytes);
    if ("file" in outcome) {
      files.push(outcome.file);
    } else {
      rejected.push({
        name: basename(abs),
        path: abs,
        reason: outcome.reason,
      });
    }
  }
  return { files, rejected };
};

/** Text appended to the reply for every file that could not be attached. */
export const rejectionNote = (rejected: RejectedFile): string =>
  MISSING_REASONS.has(rejected.reason)
    ? `[attachment missing: ${rejected.name}]`
    : `[attachment refused: ${rejected.name}]`;
