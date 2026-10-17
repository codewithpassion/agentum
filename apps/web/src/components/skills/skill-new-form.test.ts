import { expect, test } from "bun:test";
import { buildSkillMarkdown } from "./skill-new-form.tsx";

test("buildSkillMarkdown writes frontmatter with the skill name and description", () => {
  expect(buildSkillMarkdown("pelican-notes", "Takes notes")).toBe(
    "---\nname: pelican-notes\ndescription: Takes notes\n---\n\n# pelican-notes\n"
  );
});

test("buildSkillMarkdown keeps an empty description as an empty value", () => {
  expect(buildSkillMarkdown("a", "")).toBe(
    "---\nname: a\ndescription: \n---\n\n# a\n"
  );
});
