import {
  libraryPathsError,
  libraryPathsOf,
} from "@repo/services/library/sync-paths";

/** The list after adding `added`, or the reason it cannot be added. */
export const nextLibraryPaths = (
  current: readonly string[],
  added: string
): { paths: string[] } | { error: string } => {
  const trimmed = added.trim();
  if (trimmed === "") {
    return { error: "Type a folder or file path." };
  }
  const libraryPaths = [...current, trimmed];
  const error = libraryPathsError({ libraryPaths });
  if (error !== undefined) {
    return { error };
  }
  return { paths: libraryPathsOf({ libraryPaths }) };
};

/** The list without `path`. */
export const withoutPath = (
  current: readonly string[],
  path: string
): string[] => current.filter((item) => item !== path);
