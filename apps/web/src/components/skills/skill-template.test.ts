import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "#/modules/skills/validate";
import {
  skillTemplate,
  withFrontmatterField,
  withoutFrontmatter,
} from "./skill-template";

describe("skillTemplate", () => {
  test("declares the slug as its name, which is what the API demands", () => {
    const frontmatter = parseFrontmatter(
      skillTemplate("weekly-report", "Writes the Monday report.")
    );

    expect(frontmatter?.name).toBe("weekly-report");
    expect(frontmatter?.description).toBe("Writes the Monday report.");
  });
});

describe("withoutFrontmatter", () => {
  test("drops the block markdown would render as a heading", () => {
    const body = withoutFrontmatter(skillTemplate("greeter", "Says hello."));

    expect(body.startsWith("## When to use this")).toBe(true);
    expect(body).not.toContain("description: Says hello.");
  });

  test("leaves a file that has no frontmatter alone", () => {
    expect(withoutFrontmatter("# Title\n\nProse.")).toBe("# Title\n\nProse.");
  });
});

describe("withFrontmatterField", () => {
  test("rewrites a field in place and leaves the body alone", () => {
    const next = withFrontmatterField(
      skillTemplate("draft", "Placeholder."),
      "name",
      "renamed"
    );

    expect(parseFrontmatter(next)?.name).toBe("renamed");
    expect(parseFrontmatter(next)?.description).toBe("Placeholder.");
    expect(next).toContain("## When to use this");
  });

  test("adds a missing field without disturbing the others", () => {
    const next = withFrontmatterField(
      "---\nname: solo\n---\n\nBody.",
      "description",
      "Says what it does."
    );

    expect(next).toBe(
      "---\nname: solo\ndescription: Says what it does.\n---\n\nBody."
    );
  });

  test("wraps a file that has no frontmatter at all", () => {
    const next = withFrontmatterField("Just prose.", "name", "prose");

    expect(parseFrontmatter(next)?.name).toBe("prose");
    expect(next.endsWith("Just prose.")).toBe(true);
  });
});
