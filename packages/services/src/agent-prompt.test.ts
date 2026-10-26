import { expect, test } from "bun:test";
import { agentPrompt } from "./agent-prompt.ts";

const agent = { instructions: "Do the work.", soul: "", handsTo: [] as string[] };

test("empty voice and hands to add no sections", () => {
  expect(agentPrompt(agent, [])).toBe("Do the work.");
});

test("voice follows instructions", () => {
  expect(agentPrompt({ ...agent, soul: "Be warm." }, [])).toBe(
    "Do the work.\n\n## Voice\nBe warm."
  );
});

test("hands to follows instructions", () => {
  expect(agentPrompt({ ...agent, handsTo: ["a", "b"] }, ["Alpha", "Beta"])).toBe(
    "Do the work.\n\nYou can hand work to: Alpha, Beta (use send_message)"
  );
});

test("voice precedes hands to", () => {
  expect(agentPrompt({ ...agent, soul: "Be warm.", handsTo: ["a"] }, ["Alpha"])).toBe(
    "Do the work.\n\n## Voice\nBe warm.\n\nYou can hand work to: Alpha (use send_message)"
  );
});

test("no active hands to targets adds no empty handoff line", () => {
  expect(agentPrompt({ ...agent, handsTo: ["archived"] }, [])).toBe("Do the work.");
});
