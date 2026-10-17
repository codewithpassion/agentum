import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { ServiceError } from "../errors.ts";
import {
  readSkillMeta,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
} from "../library/skill-file.ts";
import { assertSafePath, assertTreeShape } from "./paths.ts";

export const SKILL_FILE = "SKILL.md";

/** One file of a version's tree, without its bytes. */
export interface TreeFile {
  executable: boolean;
  /** SHA-256 of the bytes, lower-case hex. */
  hash: string;
  path: string;
  size: number;
}

/** A tree file on its way into a version. `bytes` is set when the content is new, so it must be stored. */
export interface PlannedFile extends TreeFile {
  bytes?: Uint8Array;
}

export const TOO_BIG = `Skills are limited to ${SKILLS_MAX_FILES} files and ${SKILLS_MAX_BYTES / (1024 * 1024)} MB`;

const BAD_NAME =
  "Skill names use lowercase letters, digits and single hyphens, up to 64 characters";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** SHA-256 of `bytes`, lower-case hex. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // A copy, because digest takes a view over a plain ArrayBuffer only.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** Refuses a skill name that today's SKILL.md `name` rule would refuse. */
export const assertSkillName = (name: string): void => {
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_PATTERN.test(name)) {
    throw new ServiceError("invalid", BAD_NAME);
  }
};

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
};

/** Refuses a SKILL.md that is not UTF-8 text or whose frontmatter breaks a rule for the skill `name`. */
export const assertSkillFile = (name: string, bytes: Uint8Array): void => {
  const text = decodeUtf8(bytes);
  if (text === null) {
    throw new ServiceError("invalid", "SKILL.md is not valid UTF-8 text");
  }
  const result = readSkillMeta(text, name);
  if ("error" in result) {
    throw new ServiceError("invalid", result.error);
  }
};

/**
 * Everything a version's tree must satisfy: safe distinct paths, at most
 * `SKILLS_MAX_FILES` files and `SKILLS_MAX_BYTES` bytes, and a SKILL.md at the
 * root. A SKILL.md with new bytes is checked against the skill's name.
 */
export const assertTree = (
  name: string,
  files: readonly PlannedFile[]
): void => {
  for (const file of files) {
    assertSafePath(file.path);
  }
  assertTreeShape(files.map((file) => file.path));
  if (files.length > SKILLS_MAX_FILES) {
    throw new ServiceError("invalid", TOO_BIG);
  }
  let total = 0;
  for (const file of files) {
    total += file.size;
  }
  if (total > SKILLS_MAX_BYTES) {
    throw new ServiceError("invalid", TOO_BIG);
  }
  const skillFile = files.find((file) => file.path === SKILL_FILE);
  if (!skillFile) {
    throw new ServiceError("invalid", "SKILL.md is missing");
  }
  if (skillFile.bytes) {
    assertSkillFile(name, skillFile.bytes);
  }
};

/** Whether two trees hold the same paths with the same bytes and executable flags. */
export const sameTree = (
  left: readonly TreeFile[],
  right: readonly TreeFile[]
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const key = (file: TreeFile) =>
    `${file.path}\0${file.hash}\0${file.executable}`;
  const keys = new Set(left.map(key));
  return right.every((file) => keys.has(key(file)));
};
