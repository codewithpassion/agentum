export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_NAME_MAX = 64;

/** Lower-case words of letters and digits, joined by single hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BOM = "\uFEFF";
const FENCE = "---";
const KEY_LINE = /^([A-Za-z_][\w-]*):(.*)$/;
const BLOCK_SCALAR = /^[>|]-?$/;
const INDENTED = /^[ \t]/;
const SINGLE_QUOTED = /^'((?:[^']|'')*)'\s*(?:#.*)?$/;
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
const LINE_BREAK = /\r?\n/;
const PARAGRAPH_BREAK = /\n\s*\n/;
const TRAILING_COMMENT = /(^|\s)#.*$/;

/** Drops a ` # comment` that follows a plain value. */
const stripComment = (text: string): string =>
  text.replace(TRAILING_COMMENT, "");

/** The value of a quoted scalar on one line, or null when `raw` is not quoted. */
const unquote = (raw: string): string | null => {
  const single = SINGLE_QUOTED.exec(raw);
  if (single !== null) {
    return (single[1] ?? "").replaceAll("''", "'");
  }
  const double = DOUBLE_QUOTED.exec(raw);
  if (double !== null) {
    return (double[1] ?? "").replace(/\\(["\\])/g, "$1");
  }
  return null;
};

/** Lines from `start` that are indented, or blank when `keepBlank` is set. */
const indentedRun = (
  block: readonly string[],
  start: number,
  keepBlank: boolean
): string[] => {
  const run: string[] = [];
  for (const line of block.slice(start)) {
    const blank = line.trim() === "";
    if (blank ? !keepBlank : !INDENTED.test(line)) {
      break;
    }
    run.push(line);
  }
  return run;
};

/** A `>` or `|` block: the lines share the least indentation, then join. */
const blockScalar = (lines: readonly string[], folded: boolean): string => {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  const text = lines.map((line) => line.slice(indent)).join("\n");
  if (!folded) {
    return text.trim();
  }
  // Lines in a paragraph join with a space. A blank line ends the paragraph.
  return text
    .split(PARAGRAPH_BREAK)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .join(" ")
    )
    .join("\n")
    .trim();
};

/** The value of the top-level key on `block[index]`, given its text after the colon. */
const valueAt = (
  block: readonly string[],
  index: number,
  raw: string
): string => {
  if (BLOCK_SCALAR.test(raw)) {
    const lines = indentedRun(block, index + 1, true);
    return blockScalar(lines, raw.startsWith(">"));
  }
  const quoted = unquote(raw);
  if (quoted !== null) {
    return quoted.trim();
  }
  return [raw, ...indentedRun(block, index + 1, false)]
    .map((line) => stripComment(line.trim()).trim())
    .filter((line) => line !== "")
    .join(" ");
};

/** The first value of each top-level key in the frontmatter block. */
const topLevelValues = (block: readonly string[]): Map<string, string> => {
  const values = new Map<string, string>();
  block.forEach((line, index) => {
    const match = KEY_LINE.exec(line);
    if (match === null) {
      return;
    }
    const key = match[1] ?? "";
    if (values.has(key)) {
      return;
    }
    values.set(key, valueAt(block, index, (match[2] ?? "").trim()));
  });
  return values;
};

/**
 * Reads and checks the frontmatter of a SKILL.md. `folder` is the skill's
 * folder name, which the frontmatter `name` must match. Returns the name and
 * description, or the first rule the file breaks.
 */
export const readSkillMeta = (
  text: string,
  folder: string
): { meta: { name: string; description: string } } | { error: string } => {
  const lines = (text.startsWith(BOM) ? text.slice(BOM.length) : text).split(
    LINE_BREAK
  );
  const close = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === FENCE
  );
  if (lines[0]?.trimEnd() !== FENCE || close === -1) {
    return { error: "SKILL.md must start with a --- frontmatter block" };
  }
  const values = topLevelValues(lines.slice(1, close));
  const name = values.get("name") ?? "";
  if (name === "") {
    return { error: "Frontmatter needs a name" };
  }
  const description = values.get("description") ?? "";
  if (description === "") {
    return { error: "Frontmatter needs a description" };
  }
  if (name !== folder) {
    return { error: `The name "${name}" must match the folder "${folder}"` };
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return {
      error: `The description is ${description.length} characters, the limit is ${SKILL_DESCRIPTION_MAX.toLocaleString("en-US")}`,
    };
  }
  return { meta: { description, name } };
};

/**
 * The owner and skill folder when `path` is exactly
 * `skills/<owner>/<skill>/SKILL.md`, else null. `path` is already normalized.
 */
export const skillFileAt = (
  path: string
): { owner: string; skill: string } | null => {
  const segments = path.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "skills" ||
    segments[3] !== "SKILL.md"
  ) {
    return null;
  }
  const owner = segments[1] ?? "";
  const skill = segments[2] ?? "";
  if (owner === "" || skill === "") {
    return null;
  }
  return { owner, skill };
};
