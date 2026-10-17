import { expect, test } from "bun:test";
import {
  readSkillMeta,
  SKILL_DESCRIPTION_MAX,
  skillFileAt,
} from "./skill-file.ts";

const errorOf = (text: string, folder = "pdf") => {
  const result = readSkillMeta(text, folder);
  if (!("error" in result)) {
    throw new Error("expected an error");
  }
  return result.error;
};

test("a valid file gives its name and description", () => {
  const plain = "---\nname: pdf\ndescription: Reads PDFs.\n---\n# Body";
  expect(readSkillMeta(plain, "pdf")).toEqual({
    meta: { description: "Reads PDFs.", name: "pdf" },
  });

  const quoted = `---\nname: "pdf"\ndescription: 'Reads: "PDFs"'\n---\n`;
  expect(readSkillMeta(quoted, "pdf")).toEqual({
    meta: { description: 'Reads: "PDFs"', name: "pdf" },
  });

  const folded = [
    "---",
    "name: pdf",
    "description: >-",
    "  Reads PDFs",
    "  and forms.",
    "",
    "  Second paragraph.",
    "other: ignored",
    "---",
  ].join("\n");
  expect(readSkillMeta(folded, "pdf")).toEqual({
    meta: {
      description: "Reads PDFs and forms.\nSecond paragraph.",
      name: "pdf",
    },
  });
});

test("a plain value continues on more-indented lines", () => {
  const text =
    "---\nname: pdf\ndescription: Reads\n  PDFs # not a comment\n---\n";
  expect(readSkillMeta(text, "pdf")).toEqual({
    meta: { description: "Reads PDFs", name: "pdf" },
  });
});

test("a literal block keeps its line breaks", () => {
  const text = "---\nname: pdf\ndescription: |\n  one\n  two\n---\n";
  expect(readSkillMeta(text, "pdf")).toEqual({
    meta: { description: "one\ntwo", name: "pdf" },
  });
});

test("comment lines are ignored", () => {
  const text =
    "---\n# a note\nname: pdf\n# another\ndescription: Reads PDFs.\n---\n";
  expect(readSkillMeta(text, "pdf")).toEqual({
    meta: { description: "Reads PDFs.", name: "pdf" },
  });
});

test("no frontmatter block is an error", () => {
  const message = "SKILL.md must start with a --- frontmatter block";
  expect(errorOf("# Just a body\n")).toBe(message);
  expect(errorOf("\n---\nname: pdf\n---\n")).toBe(message);
  expect(errorOf("")).toBe(message);
});

test("an unclosed frontmatter block is an error", () => {
  expect(errorOf("---\nname: pdf\ndescription: Reads PDFs.\n")).toBe(
    "SKILL.md must start with a --- frontmatter block"
  );
});

test("a missing name is an error", () => {
  expect(errorOf("---\ndescription: Reads PDFs.\n---\n")).toBe(
    "Frontmatter needs a name"
  );
});

test("a missing description is an error", () => {
  expect(errorOf("---\nname: pdf\n---\n")).toBe(
    "Frontmatter needs a description"
  );
});

test("an empty description is an error", () => {
  expect(errorOf("---\nname: pdf\ndescription: '  '\n---\n")).toBe(
    "Frontmatter needs a description"
  );
});

test("a name that does not match the folder is an error", () => {
  expect(errorOf("---\nname: docs\ndescription: Reads PDFs.\n---\n")).toBe(
    'The name "docs" must match the folder "pdf"'
  );
});

test("a description of 1,024 characters passes and 1,025 fail", () => {
  const at = (length: number) =>
    `---\nname: pdf\ndescription: ${"a".repeat(length)}\n---\n`;
  expect(SKILL_DESCRIPTION_MAX).toBe(1024);
  expect(readSkillMeta(at(1024), "pdf")).toEqual({
    meta: { description: "a".repeat(1024), name: "pdf" },
  });
  expect(errorOf(at(1025))).toBe(
    "The description is 1025 characters, the limit is 1,024"
  );
});

test("CRLF line endings read the same", () => {
  const text =
    "---\r\nname: pdf\r\ndescription: >\r\n  Reads PDFs.\r\n---\r\n# Body";
  expect(readSkillMeta(text, "pdf")).toEqual({
    meta: { description: "Reads PDFs.", name: "pdf" },
  });
});

test("a byte order mark before the fence is skipped", () => {
  const text = "﻿---\nname: pdf\ndescription: Reads PDFs.\n---\n";
  expect(readSkillMeta(text, "pdf")).toEqual({
    meta: { description: "Reads PDFs.", name: "pdf" },
  });
});

test("skillFileAt accepts only skills/<owner>/<skill>/SKILL.md", () => {
  expect(skillFileAt("skills/acme/pdf/SKILL.md")).toEqual({
    owner: "acme",
    skill: "pdf",
  });
  expect(skillFileAt("skills/a/b/c/SKILL.md")).toBeNull();
  expect(skillFileAt("skills/a/SKILL.md")).toBeNull();
  expect(skillFileAt("skills/a/b/skill.md")).toBeNull();
  expect(skillFileAt("docs/a/b/SKILL.md")).toBeNull();
});
