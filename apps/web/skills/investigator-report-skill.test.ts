import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "investigator-report");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const SCRIPT_MENTION = /scripts\/[a-z-]+\.ts/g;

describe("investigator-report SKILL.md", () => {
  test("names only scripts that exist", () => {
    const mentioned = [...new Set(skill.match(SCRIPT_MENTION))];
    expect(mentioned.sort()).toEqual(["scripts/report.ts", "scripts/step.ts"]);
    for (const path of mentioned) {
      expect(existsSync(join(SKILL_DIR, path))).toBe(true);
    }
  });

  test("lets the investigator read, retry jobs and re-run workflows on its own", () => {
    expect(skill).toContain("Retry a failed job");
    expect(skill).toContain("Re-run a workflow");
  });

  test("sends config, credential, email and post actions to Dom first", () => {
    expect(skill).toContain("## What needs Dom's approval first");
    expect(skill).toContain("credentials");
    expect(skill).toContain("Anything that sends email");
    expect(skill).toContain("Anything that posts");
  });

  test("escalates when approval is denied or cannot be asked for", () => {
    expect(skill).toContain("Dom denies");
    expect(skill).toContain("have no `ask_user` tool, do not act");
  });
});
