import { ServiceError } from "../errors.ts";

export const LIBRARY_PATH_MAX_BYTES = 512;
export const LIBRARY_PATH_MAX_SEGMENTS = 20;

const CONTROL_CHARS = /\p{Cc}/u;
const encoder = new TextEncoder();

const invalid = (message: string) => new ServiceError("invalid", message);

/**
 * The one place library paths are cleaned. Returns the path without a leading
 * slash, `.` and empty segments dropped and `..` resolved; the root is the
 * empty string. Refuses a `..` that climbs past the root, control characters,
 * more than 512 bytes and more than 20 segments.
 */
export const normalizePath = (raw: string): string => {
  if (CONTROL_CHARS.test(raw)) {
    throw invalid("Path contains control characters");
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    if (segments.length === 0) {
      throw invalid("Path leaves the library");
    }
    segments.pop();
  }
  if (segments.length > LIBRARY_PATH_MAX_SEGMENTS) {
    throw invalid(`Path has more than ${LIBRARY_PATH_MAX_SEGMENTS} segments`);
  }
  const path = segments.join("/");
  if (encoder.encode(path).byteLength > LIBRARY_PATH_MAX_BYTES) {
    throw invalid(`Path is longer than ${LIBRARY_PATH_MAX_BYTES} bytes`);
  }
  return path;
};

/** The folder holding `path`. The root is the empty string. */
export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

/** Every folder above `path`, outermost first: `a/b/c` gives `a`, `a/b`. */
export const ancestorsOf = (path: string): string[] => {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
};
