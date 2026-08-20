import { describe, expect, test } from "bun:test";
import {
  MAX_SKILL_FILE_BYTES,
  parseFrontmatter,
  validateSkill,
} from "./validate";

/**
 * The rules the live API enforces (probed by the Phase 5 entry spike) plus the
 * two it does not: a description must be declared rather than inferred from the
 * body, and a path may not walk out of the skill directory.
 */

const BAD_SLUG = /not a valid skill slug/;
const NO_SKILL_MD = /needs a SKILL\.md at its root/;
const NO_FRONTMATTER = /YAML frontmatter/;
const NO_DESCRIPTION = /needs a "description" field/;
const NAME_MISMATCH = /They must match/;
const PATH_ESCAPE = /walks outside/;
const PATH_ABSOLUTE = /is absolute/;
const PATH_EMPTY_SEGMENT = /empty path segment/;
const PATH_DUPLICATE = /appears twice/;
const FILE_TOO_LARGE = /is larger than/;

const SLUG = "weekly-report";

const skillMd = (
  overrides: { description?: string; name?: string } = {}
): string =>
  `---
name: ${overrides.name ?? SLUG}
description: ${overrides.description ?? "Build the weekly report from the ops channel."}
---

# Weekly report

Run scripts/run.ts.
`;

const validFiles = () => [
  { content: skillMd(), path: "SKILL.md" },
  { content: "console.log('hi');\n", path: "scripts/run.ts" },
];

const reasonOf = (result: ReturnType<typeof validateSkill>): string =>
  result.ok ? "" : result.reason;

describe("parseFrontmatter", () => {
  test("reads name and description, unquoting values", () => {
    expect(
      parseFrontmatter("---\nname: \"a-b\"\ndescription: 'does a thing'\n---\n")
    ).toEqual({ description: "does a thing", name: "a-b" });
  });

  test("returns null when the document has no frontmatter block", () => {
    expect(parseFrontmatter("# just prose\n")).toBeNull();
  });

  test("treats a missing key as absent rather than empty", () => {
    expect(parseFrontmatter("---\nname: a-b\n---\n")?.description).toBeNull();
  });
});

describe("validateSkill", () => {
  test("accepts a well-formed skill and lifts its frontmatter", () => {
    const result = validateSkill({ files: validFiles(), slug: SLUG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe(SLUG);
      expect(result.skill.description).toContain("weekly report");
      expect(result.skill.files.map((file) => file.path)).toEqual([
        "SKILL.md",
        "scripts/run.ts",
      ]);
    }
  });

  test("refuses a slug that is not lowercase kebab-case", () => {
    // The slug is a URL segment, an R2 prefix and Anthropic's directory name.
    expect(
      reasonOf(validateSkill({ files: validFiles(), slug: "Weekly Report" }))
    ).toMatch(BAD_SLUG);
  });

  test("refuses a skill with no SKILL.md at the root", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [{ content: "x", path: "docs/SKILL.md" }],
          slug: SLUG,
        })
      )
    ).toMatch(NO_SKILL_MD);
  });

  test("refuses a SKILL.md with no frontmatter", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [{ content: "# no frontmatter\n", path: "SKILL.md" }],
          slug: SLUG,
        })
      )
    ).toMatch(NO_FRONTMATTER);
  });

  test("refuses a missing description, which the API would infer", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [{ content: `---\nname: ${SLUG}\n---\n`, path: "SKILL.md" }],
          slug: SLUG,
        })
      )
    ).toMatch(NO_DESCRIPTION);
  });

  test("refuses a frontmatter name that disagrees with the slug", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [
            { content: skillMd({ name: "something-else" }), path: "SKILL.md" },
          ],
          slug: SLUG,
        })
      )
    ).toMatch(NAME_MISMATCH);
  });

  test("refuses a path that walks outside the skill directory", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [...validFiles(), { content: "x", path: "../escape.sh" }],
          slug: SLUG,
        })
      )
    ).toMatch(PATH_ESCAPE);
  });

  test("refuses an absolute path", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [...validFiles(), { content: "x", path: "/etc/passwd" }],
          slug: SLUG,
        })
      )
    ).toMatch(PATH_ABSOLUTE);
  });

  test("refuses an empty path segment", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [...validFiles(), { content: "x", path: "scripts//run.ts" }],
          slug: SLUG,
        })
      )
    ).toMatch(PATH_EMPTY_SEGMENT);
  });

  test("refuses the same path twice", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [...validFiles(), { content: "y", path: "scripts/run.ts" }],
          slug: SLUG,
        })
      )
    ).toMatch(PATH_DUPLICATE);
  });

  test("refuses a file over the per-file cap", () => {
    expect(
      reasonOf(
        validateSkill({
          files: [
            ...validFiles(),
            { content: "x".repeat(MAX_SKILL_FILE_BYTES + 1), path: "big.txt" },
          ],
          slug: SLUG,
        })
      )
    ).toMatch(FILE_TOO_LARGE);
  });

  test("strips the slug directory when every path carries it", () => {
    const result = validateSkill({
      files: [
        { content: skillMd(), path: `${SLUG}/SKILL.md` },
        { content: "x", path: `${SLUG}/scripts/run.ts` },
      ],
      slug: SLUG,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.files.map((file) => file.path)).toEqual([
        "SKILL.md",
        "scripts/run.ts",
      ]);
    }
  });

  test("leaves a real subdirectory of the same name alone", () => {
    // Stripping per file would turn "weekly-report/helper.ts" into "helper.ts"
    // and lose a directory the author meant to keep.
    const result = validateSkill({
      files: [
        { content: skillMd(), path: "SKILL.md" },
        { content: "x", path: `${SLUG}/helper.ts` },
      ],
      slug: SLUG,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.files.map((file) => file.path)).toEqual([
        "SKILL.md",
        `${SLUG}/helper.ts`,
      ]);
    }
  });
});
