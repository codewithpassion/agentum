import { clamp } from "../library-bash/library-fs.ts";
import { LIBRARY_MOUNT } from "../library-bash/run.ts";

/**
 * The part of a path that sits under the library root, with a leading slash.
 * A relative path starts in `home`. An absolute path must be `/library` or
 * under it.
 */
const underRoot = (home: string, path: string): string => {
  if (path === LIBRARY_MOUNT || path.startsWith(`${LIBRARY_MOUNT}/`)) {
    return path.slice(LIBRARY_MOUNT.length);
  }
  if (path.startsWith("/")) {
    throw new Error(`Path is outside ${LIBRARY_MOUNT}: ${path}`);
  }
  return `/${home}/${path}`;
};

/**
 * The library path a script's path means: no leading slash, `""` for the
 * root. `home` is a library path with no slash at either end, or `""` for the
 * root. `.` and `..` resolve against the library root, so `..` cannot climb
 * above it.
 */
export const libraryPathOf = (home: string, path: string): string =>
  clamp(underRoot(home, path)).slice(1);
