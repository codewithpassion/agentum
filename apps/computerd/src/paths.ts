/**
 * Path rules for the daemon. The first half mirrors `validatePath` in
 * `apps/web/src/modules/computer/paths.ts` - Agentum runs those checks before
 * anything reaches the wire, but the daemon holds a real filesystem and is
 * reachable by anything that has its token, so it re-runs them rather than
 * trusting the caller.
 *
 * The second half is the rule the Durable Object never needed: a request path
 * is resolved *under* the root (`/notes/plan.md` -> `${root}/notes/plan.md`) and
 * refused if it lands outside it. `..` is already rejected above, so the case
 * this actually catches is a symlink pointing out of the root - which an agent
 * can create for itself with one `exec`.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MAX_PATH_LENGTH = 1024;

/** What a read returns before it is refused outright; mirrors the web cap. */
export const MAX_READ_BYTES = 256_000;

const REPEATED_SLASHES = /\/{2,}/g;

export type PathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export const validateRequestPath = (raw: unknown): PathResult => {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "A path is required." };
  }
  if (!raw.startsWith("/")) {
    return {
      ok: false,
      reason: `Paths must be absolute and start with "/" - got "${raw}".`,
    };
  }
  if (raw.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      reason: `Paths must be at most ${MAX_PATH_LENGTH} characters.`,
    };
  }
  if (raw.includes("\0")) {
    return { ok: false, reason: "Paths must not contain null bytes." };
  }

  const collapsed = raw.replace(REPEATED_SLASHES, "/");
  for (const segment of collapsed.split("/").slice(1)) {
    if (segment === "." || segment === "..") {
      return {
        ok: false,
        reason: `Paths must be already resolved: "." and ".." are not allowed (got "${raw}").`,
      };
    }
  }

  const trimmed =
    collapsed.length > 1 && collapsed.endsWith("/")
      ? collapsed.slice(0, -1)
      : collapsed;
  return { ok: true, path: trimmed };
};

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}/`);

/**
 * `realpath` needs the path to exist, and a write targets one that does not
 * yet. Walking up to the deepest existing ancestor and re-attaching the tail
 * answers the only question that matters: whichever symlinks are already on the
 * path, where does it come out?
 */
const resolveThroughSymlinks = async (target: string): Promise<string> => {
  const tail: string[] = [];
  let current = target;

  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each step depends on the previous one failing
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return target;
      }
      tail.push(basename(current));
      current = parent;
    }
  }
};

export type ResolvedPath =
  | { abs: string; ok: true; path: string }
  | { ok: false; reason: string };

/**
 * `path` is the request path (kept for error messages and the activity log, so
 * an agent is told about the path it asked for); `abs` is where that lands on
 * this machine.
 */
export const resolveInRoot = async (
  root: string,
  raw: unknown
): Promise<ResolvedPath> => {
  const requested = validateRequestPath(raw);
  if (!requested.ok) {
    return requested;
  }

  // The leading "." keeps `resolve` from treating the request path as an
  // absolute path on this machine and dropping the root.
  const abs = resolve(root, `.${requested.path}`);
  const real = await resolveThroughSymlinks(abs);
  if (!(isInside(root, abs) && isInside(root, real))) {
    return {
      ok: false,
      reason: `${requested.path} resolves outside the computer root.`,
    };
  }
  return { abs, ok: true, path: requested.path };
};

export const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;
