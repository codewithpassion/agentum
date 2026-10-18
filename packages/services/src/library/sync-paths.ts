// The library paths an agent syncs into its working copy, listed in its
// `runtimeConfig` under `libraryPaths`. The agent's own home is always a root.
import { isServiceError } from "../errors.ts";
import { agentHomePath } from "./home.ts";
import { normalizePath } from "./path.ts";

/** The key in an agent's `runtimeConfig`. */
export const LIBRARY_PATHS_KEY = "libraryPaths";

const WHOLE_LIBRARY =
  "A library path cannot be the whole library. Name a folder or file in it.";

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

/** A message when `runtimeConfig` holds bad library paths, undefined when the key is absent or every path is valid. */
export const libraryPathsError = (
  runtimeConfig: Record<string, unknown>
): string | undefined => {
  const value = runtimeConfig[LIBRARY_PATHS_KEY];
  if (value === undefined) {
    return;
  }
  if (!(Array.isArray(value) && value.every(isPathItem))) {
    return `"${LIBRARY_PATHS_KEY}" must be a list of non-empty library paths.`;
  }
  for (const raw of value) {
    const cleaned = cleanPath(raw);
    if ("problem" in cleaned) {
      return cleaned.problem;
    }
    if (cleaned.path === "") {
      return WHOLE_LIBRARY;
    }
  }
};

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
