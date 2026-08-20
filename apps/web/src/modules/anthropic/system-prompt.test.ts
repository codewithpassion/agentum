import { describe, expect, test } from "bun:test";
import {
  composeSystemPrompt,
  rosterFor,
  type SystemPromptInput,
} from "./system-prompt";

const input = (
  overrides: Partial<SystemPromptInput> = {}
): SystemPromptInput => ({
  instructions: "Triage requests and delegate what you cannot answer.",
  name: "Chief of Staff",
  roster: [{ name: "Researcher", soul: "Digs until the answer is solid." }],
  soul: "Calm, decisive, allergic to busywork.",
  ...overrides,
});

describe("composeSystemPrompt", () => {
  test("carries the agent's own identity, soul and instructions", () => {
    const prompt = composeSystemPrompt(input());

    expect(prompt).toContain("You are Chief of Staff");
    expect(prompt).toContain("allergic to busywork");
    expect(prompt).toContain("Triage requests");
  });

  test("teaches the workspace tools and the house style", () => {
    const prompt = composeSystemPrompt(input());

    expect(prompt).toContain("post_message");
    expect(prompt).toContain("read_channel");
    expect(prompt).toContain("threadParentId");
    expect(prompt).toContain("@Name");
    expect(prompt).toContain("wiki_write");
    expect(prompt).toContain("concise");
  });

  test("names the skill tools and the self-heal contract", () => {
    const prompt = composeSystemPrompt(input());

    // The instructions *are* the auto-heal mechanism in v1: detection is
    // in-session, and this paragraph is what turns a failure into a fix.
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("skill_create");
    expect(prompt).toContain("skill_update");
    expect(prompt).toContain("When a skill fails, fix the skill");
    expect(prompt).toContain("changelog");
  });

  test("lists the other agents with their souls so delegation is possible", () => {
    const prompt = composeSystemPrompt(input());

    expect(prompt).toContain("@Researcher");
    expect(prompt).toContain("Digs until the answer is solid.");
  });

  test("says so plainly when there is nobody to delegate to", () => {
    const prompt = composeSystemPrompt(input({ roster: [] }));

    expect(prompt).toContain("only agent in the workspace");
  });

  test("omits empty sections rather than leaving stray headings", () => {
    const prompt = composeSystemPrompt(input({ instructions: "", soul: "  " }));

    expect(prompt).not.toContain("Your instructions");
    expect(prompt).toContain("You are Chief of Staff");
  });
});

describe("rosterFor", () => {
  test("is everybody except the agent itself", () => {
    const agents = [
      { id: "cos", name: "Chief of Staff", soul: "a" },
      { id: "res", name: "Researcher", soul: "b" },
    ];

    expect(rosterFor("cos", agents)).toEqual([
      { name: "Researcher", soul: "b" },
    ]);
  });
});
