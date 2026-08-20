/**
 * The SKILL.md a new skill starts from, and the one rule the create form has to
 * keep: the frontmatter `name` is the slug (the API refuses a mismatch), and the
 * description shown in the directory is the frontmatter's.
 *
 * The form edits the file, not a model of it - so typing a slug rewrites the
 * `name:` line in place and leaves everything else the author wrote alone.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const NEWLINE = /\r?\n/;

const fieldLine = (key: string, value: string): string => `${key}: ${value}`;

const isField = (line: string, key: string): boolean =>
  line.trimStart().toLowerCase().startsWith(`${key.toLowerCase()}:`);

/**
 * Sets a frontmatter field, adding it when the file has none. Values stay
 * unquoted: the server's reader accepts both and an unquoted line is what a
 * human editing the file after us will keep writing.
 */
export const withFrontmatterField = (
  source: string,
  key: string,
  value: string
): string => {
  const match = FRONTMATTER.exec(source);
  if (!match?.[1]) {
    return `---\n${fieldLine(key, value)}\n---\n\n${source}`;
  }

  const lines = match[1].split(NEWLINE);
  const index = lines.findIndex((line) => isField(line, key));
  if (index === -1) {
    lines.push(fieldLine(key, value));
  } else {
    lines[index] = fieldLine(key, value);
  }

  return `---\n${lines.join("\n")}\n---${source.slice(match[0].length - (match[2]?.length ?? 0))}`;
};

/**
 * The prose, without the frontmatter. Markdown has no notion of frontmatter:
 * `---` under two `key: value` lines is a setext heading, so rendering the file
 * whole turns its metadata into a heading. The name and the description are on
 * the page already, so the block is dropped rather than rendered.
 */
export const withoutFrontmatter = (source: string): string => {
  const match = FRONTMATTER.exec(source);
  return match ? source.slice(match[0].length).trimStart() : source;
};

/** What a new skill's SKILL.md says before its author says anything. */
export const skillTemplate = (slug: string, description: string): string =>
  [
    "---",
    fieldLine("name", slug),
    fieldLine("description", description),
    "---",
    "",
    // No title heading: the skill's name is its frontmatter, shown on the page
    // already, and a heading typed here would go stale the moment the slug
    // field changes.
    "## When to use this",
    "",
    "Describe the job this skill does, and when an agent should reach for it.",
    "",
    "## How to use it",
    "",
    "1. Step one.",
    "2. Step two.",
    "",
  ].join("\n");
