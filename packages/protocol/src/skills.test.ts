import { describe, expect, test } from "bun:test";
import {
  githubSkillSourceSchema,
  skillGitPathSchema,
  skillGitRefSchema,
  skillGitUrlSchema,
} from "./skills";

const base = {
  provider: "github",
  ref: "main",
  repoUrl: "https://github.com/acme/skills",
};

describe("skillGitUrlSchema", () => {
  test.each([
    "https://github.com/acme/skills",
    "https://github.com/acme/skills.git",
    "https://github.com/acme/skills/",
  ])("accepts %s", (url) => {
    expect(skillGitUrlSchema.safeParse(url).success).toBe(true);
  });

  test.each([
    "https://gitlab.com/acme/skills",
    "https://gitlab.com/group/sub/skills",
    "http://github.com/acme/skills",
    "https://github.com/acme/..",
    "https://github.com/../skills",
    "https://github.com/acme/skills/extra",
  ])("rejects %s", (url) => {
    expect(skillGitUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe("skillGitPathSchema", () => {
  test("accepts a subdirectory", () => {
    expect(skillGitPathSchema.safeParse("skills/shout").success).toBe(true);
  });

  test.each(["skills/../etc", "skills/./shout", "./shout", "///"])(
    "rejects %s",
    (path) => {
      expect(skillGitPathSchema.safeParse(path).success).toBe(false);
    }
  );
});

describe("skillGitRefSchema", () => {
  test.each([
    "main",
    "v1.2.3",
    "feature/x",
    "0123456789abcdef0123456789abcdef01234567",
  ])("accepts %s", (ref) => {
    expect(skillGitRefSchema.safeParse(ref).success).toBe(true);
  });

  test.each(["has space", "../main", "main/..", "///"])("rejects %s", (ref) => {
    expect(skillGitRefSchema.safeParse(ref).success).toBe(false);
  });
});

describe("githubSkillSourceSchema", () => {
  test("accepts a source with and without a path", () => {
    expect(githubSkillSourceSchema.safeParse(base).success).toBe(true);
    expect(
      githubSkillSourceSchema.safeParse({ ...base, path: "skills/shout" })
        .success
    ).toBe(true);
  });

  test("rejects an unknown extra key", () => {
    expect(
      githubSkillSourceSchema.safeParse({ ...base, extra: true }).success
    ).toBe(false);
  });

  test("rejects a provider other than github", () => {
    expect(
      githubSkillSourceSchema.safeParse({ ...base, provider: "gitlab" }).success
    ).toBe(false);
  });

  test("rejects a bad path inside the source", () => {
    expect(
      githubSkillSourceSchema.safeParse({ ...base, path: "a/../b" }).success
    ).toBe(false);
  });
});
