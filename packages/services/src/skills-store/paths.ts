import { ServiceError } from "../errors.ts";

export const SKILL_PATH_MAX_BYTES = 512;
export const SKILL_PATH_MAX_SEGMENTS = 20;

const CONTROL_CHARACTER = /\p{Cc}/u;
const encoder = new TextEncoder();

/** Refuses a path that is not a safe relative path inside a skill. Does not rewrite it. */
export const assertSafePath = (path: string): void => {
  if (path === "") {
    throw new ServiceError("invalid", "Skill path must not be empty");
  }
  if (path.startsWith("/")) {
    throw new ServiceError("invalid", "Skill path must be relative");
  }
  if (path.includes("\\")) {
    throw new ServiceError(
      "invalid",
      "Skill path must use / and no backslashes"
    );
  }
  if (CONTROL_CHARACTER.test(path)) {
    throw new ServiceError(
      "invalid",
      "Skill path must not contain control characters"
    );
  }
  if (encoder.encode(path).byteLength > SKILL_PATH_MAX_BYTES) {
    throw new ServiceError(
      "invalid",
      `Skill path must be at most ${SKILL_PATH_MAX_BYTES} bytes`
    );
  }
  const segments = path.split("/");
  if (segments.length > SKILL_PATH_MAX_SEGMENTS) {
    throw new ServiceError(
      "invalid",
      `Skill path must have at most ${SKILL_PATH_MAX_SEGMENTS} segments`
    );
  }
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new ServiceError("invalid", "Skill path has an empty or dot segment");
  }
};

const folderPaths = (path: string): string[] => {
  const segments = path.split("/");
  const folders: string[] = [];
  for (let count = 1; count < segments.length; count += 1) {
    folders.push(segments.slice(0, count).join("/"));
  }
  return folders;
};

/** Refuses a file tree with a repeated path, or a file that is also a folder of another file. */
export const assertTreeShape = (paths: readonly string[]): void => {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      throw new ServiceError("invalid", `Skill path "${path}" appears twice`);
    }
    seen.add(path);
  }
  for (const path of paths) {
    for (const folder of folderPaths(path)) {
      if (seen.has(folder)) {
        throw new ServiceError(
          "invalid",
          `Skill path "${folder}" is both a file and a folder`
        );
      }
    }
  }
};
