/**
 * Everything a skill must be before it is written anywhere. Pure, so the whole
 * rule set is testable without a database, a bucket or an API key.
 *
 * The rules are deliberately stricter than Anthropic's (verified against the
 * live API by the Phase 5 entry spike): the server accepts a description taken
 * from body text when the frontmatter has none, and we do not - a skill that
 * only half-declares itself is a skill nobody can find in the directory.
 */

export const SKILL_MD_PATH = "SKILL.md";

/** One file. Generous enough for a bundled data file, small enough to reject a mistake. */
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;

/**
 * The whole upload. Anthropic caps the multipart request at 30 MB, and the
 * multipart envelope, the path headers and the base64-free binary framing all
 * ride inside that - so the payload ceiling sits below it with room to spare.
 */
export const MAX_SKILL_TOTAL_BYTES = 25 * 1024 * 1024;

/** An agent may attach 20 skills. Enforced on assignment, clamped on compose. */
export const MAX_AGENT_SKILLS = 20;

export const MAX_SKILL_SLUG_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 2000;
export const MAX_SKILL_FILE_COUNT = 200;

/** Lowercase kebab: this string is a URL segment, an R2 prefix and a directory name. */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const FRONTMATTER_KEY = /^([A-Za-z_][\w-]*):\s?(.*)$/;
const NEWLINE = /\r?\n/;
const QUOTED = /^(['"])([\s\S]*)\1$/;

const encoder = new TextEncoder();

export interface SkillFileInput {
  content: string;
  path: string;
}

export interface ValidatedSkillFile {
  content: string;
  contentType: string;
  path: string;
  size: number;
}

export interface ValidatedSkill {
  description: string;
  files: ValidatedSkillFile[];
  name: string;
  totalBytes: number;
}

export type SkillValidation =
  | { ok: true; skill: ValidatedSkill }
  | { ok: false; reason: string };

const invalid = (reason: string): SkillValidation => ({ ok: false, reason });

export const isValidSkillSlug = (slug: string): boolean =>
  slug.length <= MAX_SKILL_SLUG_LENGTH && SLUG_PATTERN.test(slug);

const contentTypeFor = (path: string): string =>
  path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";

const byteLength = (content: string): number => encoder.encode(content).length;

/**
 * A hand-rolled reader for the two keys we care about. Skill frontmatter is
 * flat `key: value`, so a YAML dependency would buy nothing but a parser that
 * accepts far more than the API does.
 */
export interface Frontmatter {
  description: string | null;
  name: string | null;
}

export const parseFrontmatter = (source: string): Frontmatter | null => {
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match?.[1]) {
    return null;
  }

  const fields = new Map<string, string>();
  for (const line of match[1].split(NEWLINE)) {
    const field = FRONTMATTER_KEY.exec(line.trim());
    if (field?.[1]) {
      const raw = (field[2] ?? "").trim();
      const unquoted = QUOTED.exec(raw);
      fields.set(field[1].toLowerCase(), (unquoted?.[2] ?? raw).trim());
    }
  }

  return {
    description: fields.get("description") || null,
    name: fields.get("name") || null,
  };
};

const PATH_SEGMENT = /^[\w.-]+$/;

/** `null` when the path is safe; otherwise why it is not. */
const pathProblem = (path: string): string | null => {
  if (path.length === 0) {
    return "a file has an empty path";
  }
  if (path.includes("\\")) {
    return `"${path}" uses a backslash; skill paths are POSIX-style`;
  }
  if (path.startsWith("/")) {
    return `"${path}" is absolute; skill paths are relative to the skill root`;
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return `"${path}" has an empty path segment`;
    }
    if (segment === "." || segment === "..") {
      return `"${path}" walks outside the skill directory`;
    }
    if (!PATH_SEGMENT.test(segment)) {
      return `"${path}" contains characters that are not allowed in a skill path`;
    }
  }
  return null;
};

/**
 * Agents (and humans copying an example) often write the paths the way the API
 * wants them on the wire, with the skill's directory in front. Stripping is
 * all-or-none on purpose: a per-file strip would eat a real subdirectory that
 * happens to share the slug's name.
 */
const stripSlugPrefix = (
  files: readonly SkillFileInput[],
  slug: string
): SkillFileInput[] => {
  const prefix = `${slug}/`;
  if (!files.every((file) => file.path.startsWith(prefix))) {
    return [...files];
  }
  return files.map((file) => ({
    content: file.content,
    path: file.path.slice(prefix.length),
  }));
};

const checkedFiles = (
  files: readonly SkillFileInput[]
): { files: ValidatedSkillFile[]; totalBytes: number } | string => {
  const seen = new Set<string>();
  const checked: ValidatedSkillFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const problem = pathProblem(file.path);
    if (problem) {
      return problem;
    }
    if (seen.has(file.path)) {
      return `"${file.path}" appears twice`;
    }
    seen.add(file.path);

    const size = byteLength(file.content);
    if (size > MAX_SKILL_FILE_BYTES) {
      return `"${file.path}" is larger than ${MAX_SKILL_FILE_BYTES} bytes`;
    }
    totalBytes += size;
    checked.push({
      content: file.content,
      contentType: contentTypeFor(file.path),
      path: file.path,
      size,
    });
  }

  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    return `The skill is larger than ${MAX_SKILL_TOTAL_BYTES} bytes in total`;
  }
  return { files: checked, totalBytes };
};

/**
 * The gate every write goes through - the HTTP routes and the agents'
 * `skill_create`/`skill_update` alike. The slug, the frontmatter `name` and the
 * top-level directory Anthropic requires are one value, so a mismatch is
 * refused here rather than 400ing halfway through the publish.
 */
export const validateSkill = (input: {
  files: readonly SkillFileInput[];
  slug: string;
}): SkillValidation => {
  if (!isValidSkillSlug(input.slug)) {
    return invalid(
      `"${input.slug}" is not a valid skill slug. Use lowercase letters, digits and hyphens, at most ${MAX_SKILL_SLUG_LENGTH} characters.`
    );
  }
  if (input.files.length === 0) {
    return invalid("A skill needs at least a SKILL.md file.");
  }
  if (input.files.length > MAX_SKILL_FILE_COUNT) {
    return invalid(`A skill may have at most ${MAX_SKILL_FILE_COUNT} files.`);
  }

  const files = stripSlugPrefix(input.files, input.slug);
  const checked = checkedFiles(files);
  if (typeof checked === "string") {
    return invalid(`${checked}.`);
  }

  const skillMd = checked.files.find((file) => file.path === SKILL_MD_PATH);
  if (!skillMd) {
    return invalid(
      `A skill needs a ${SKILL_MD_PATH} at its root. Got: ${checked.files.map((file) => file.path).join(", ")}.`
    );
  }

  const frontmatter = parseFrontmatter(skillMd.content);
  if (!frontmatter) {
    return invalid(
      `${SKILL_MD_PATH} must start with YAML frontmatter delimited by "---" lines.`
    );
  }
  if (!frontmatter.name) {
    return invalid(`${SKILL_MD_PATH} frontmatter needs a "name" field.`);
  }
  if (frontmatter.name !== input.slug) {
    return invalid(
      `${SKILL_MD_PATH} frontmatter says name: ${frontmatter.name}, but the skill's slug is "${input.slug}". They must match.`
    );
  }
  if (!frontmatter.description) {
    return invalid(
      `${SKILL_MD_PATH} frontmatter needs a "description" field saying when to use the skill.`
    );
  }
  if (frontmatter.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return invalid(
      `The description must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`
    );
  }

  return {
    ok: true,
    skill: {
      description: frontmatter.description,
      files: checked.files,
      name: frontmatter.name,
      totalBytes: checked.totalBytes,
    },
  };
};
