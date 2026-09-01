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

  test("tells the agent it looks after its own routines and model", () => {
    const prompt = composeSystemPrompt(input());

    expect(prompt).toContain("routine_create");
    expect(prompt).toContain("routine_list");
    expect(prompt).toContain("set_model");
    // Effect-on-next-wake is the part a person will otherwise be surprised by.
    expect(prompt).toContain("next wake");
  });

  test("demands progress updates on long-running work", () => {
    const prompt = composeSystemPrompt(input());

    // The rule exists because of a real silence: 21 minutes of downloads with
    // the first message posted at the end, and a human asking "where are we
    // at?" in the middle.
    expect(prompt).toContain("Never go quiet");
    expect(prompt).toContain("progress update");
  });

  test("teaches subagent delegation and who does the talking", () => {
    const prompt = composeSystemPrompt(input());

    expect(prompt).toContain("# Subagents");
    expect(prompt).toContain("send_to_agent");
    // The cheap worker is named outright - discovering it via the delegation
    // toolset's own list tool would collide with the workspace `list_agents`.
    expect(prompt).toContain('"Worker"');
    // Subagents see none of the conversation and cannot post; the coordinator
    // briefs them fully and relays their results itself.
    expect(prompt).toContain("self-contained");
    expect(prompt).toContain("You do the talking");
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
