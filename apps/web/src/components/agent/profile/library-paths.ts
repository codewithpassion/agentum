import { libraryPathsOf } from "@repo/services/library/sync-paths";

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
  // `libraryPathsOf` leaves out a path that is invalid or the whole library.
  if (libraryPathsOf({ libraryPaths: [trimmed] }).length === 0) {
    return { error: `"${trimmed}" is not a folder or file in the library.` };
  }
  return { paths: libraryPathsOf({ libraryPaths }) };
};

/** The list without `path`. */
export const withoutPath = (
  current: readonly string[],
  path: string
): string[] => current.filter((item) => item !== path);
