import type { LibraryAccessGrant } from "@repo/db/shared";
// The library paths an agent syncs into its working copy, listed in its
// `runtimeConfig` under `libraryPaths`. The agent's own home is always a root.
import { isServiceError } from "../errors.ts";
import { agentHomePath } from "./home.ts";
import { normalizePath } from "./path.ts";

/** The key in an agent's `runtimeConfig`. */
export const LIBRARY_PATHS_KEY = "libraryPaths";

/** Cleans one raw path. Returns the path, the empty string for the whole library, or the reason it is refused. */
const cleanPath = (raw: string): { path: string } | { problem: string } => {
  try {
    return { path: normalizePath(raw) };
  } catch (error) {
    if (isServiceError(error)) {
      return {
        problem: `Library path "${raw}" is not valid: ${error.message}`,
      };
    }
    throw error;
  }
};

const isPathItem = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/** The library paths in `runtimeConfig`, normalised and de-duplicated in order. Invalid entries are left out. */
export const libraryPathsOf = (
  runtimeConfig: Record<string, unknown>
): string[] => {
  const value = runtimeConfig[LIBRARY_PATHS_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  const paths = new Set<string>();
  for (const raw of value.filter(isPathItem)) {
    const cleaned = cleanPath(raw);
    if ("path" in cleaned && cleaned.path !== "") {
      paths.add(cleaned.path);
    }
  }
  return [...paths];
};

/**
 * The folders an agent syncs: its home first, then the library paths. A root
 * inside another root is dropped, because the outer root already covers it.
 */
export const librarySyncRoots = (
  slug: string,
  runtimeConfig: Record<string, unknown>
): string[] => {
  const roots = [
    ...new Set([agentHomePath(slug), ...libraryPathsOf(runtimeConfig)]),
  ];
  return roots.filter(
    (root) => !roots.some((other) => root.startsWith(`${other}/`))
  );
};

/** Home and wiki are implicit grants. Explicit grants add access, never revoke it. */
export const librarySyncScope = (
  slug: string,
  grants: readonly LibraryAccessGrant[]
): LibraryAccessGrant[] => {
  const byPath = new Map<string, LibraryAccessGrant>();
  for (const grant of [
    { mode: "write" as const, path: agentHomePath(slug) },
    { mode: "read" as const, path: "wiki" },
    ...grants,
  ]) {
    const path = normalizePath(grant.path);
    const previous = byPath.get(path);
    byPath.set(path, {
      mode: previous?.mode === "write" ? "write" : grant.mode,
      path,
    });
  }
  const roots = [...byPath.values()];
  // Drop covered roots only when the outer grant conveys at least as much access.
  // A nested write under a read grant must survive to preserve the service rule.
  return roots.filter(
    (root) =>
      !roots.some(
        (other) =>
          other !== root &&
          root.path.startsWith(`${other.path}/`) &&
          (other.mode === "write" || root.mode === "read")
      )
  );
};
