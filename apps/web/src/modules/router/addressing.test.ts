import { describe, expect, test } from "bun:test";
import {
  type AddressingCandidate,
  buildAddressingPrompt,
  parseAddressingAnswer,
} from "./addressing";

const candidates: AddressingCandidate[] = [
  { agentId: "agent_bruce", name: "Bruce" },
  { agentId: "agent_ada", name: "Ada" },
];

describe("parseAddressingAnswer", () => {
  test("names the agent the model picked", () => {
    expect(parseAddressingAnswer("Bruce", candidates)?.agentId).toBe(
      "agent_bruce"
    );
  });

  test("is not thrown by punctuation or quoting around the name", () => {
    for (const answer of [
      '"Bruce"',
      "Bruce.",
      "`Bruce`",
      " bruce ",
      "Bruce!",
    ]) {
      expect(parseAddressingAnswer(answer, candidates)?.agentId).toBe(
        "agent_bruce"
      );
    }
  });

  test("NOBODY is nobody", () => {
    expect(parseAddressingAnswer("NOBODY", candidates)).toBeNull();
  });

  test("a name that is not a candidate wakes nobody", () => {
    // The model inventing a participant must not be read as a wake.
    expect(parseAddressingAnswer("Carol", candidates)).toBeNull();
  });

  test("an answer that is prose rather than a name wakes nobody", () => {
    expect(
      parseAddressingAnswer("I think this is meant for Bruce", candidates)
    ).toBeNull();
  });

  test("no answer at all wakes nobody", () => {
    // What a failed or timed-out model call looks like: the thread reply falls
    // back to the digest it would have had anyway.
    expect(parseAddressingAnswer(null, candidates)).toBeNull();
    expect(parseAddressingAnswer("", candidates)).toBeNull();
  });
});

describe("buildAddressingPrompt", () => {
  const thread = [
    { authorName: "Dominik", body: "@Bruce do you have memory attached?" },
    { authorName: "Bruce", body: "Yes — a persistent store." },
  ];

  test("carries the candidates, the thread and the new message", () => {
    const prompt = buildAddressingPrompt({
      candidates,
      message: { authorName: "Dominik", body: "how big is it?" },
      thread,
    });

    expect(prompt).toContain("Bruce, Ada");
    expect(prompt).toContain("Bruce: Yes — a persistent store.");
    expect(prompt).toContain("Dominik: how big is it?");
  });

  test("keeps the end of a long thread, not the start", () => {
    const long = Array.from({ length: 30 }, (_, index) => ({
      authorName: "Dominik",
      body: `turn ${index}`,
    }));

    const prompt = buildAddressingPrompt({
      candidates,
      message: { authorName: "Dominik", body: "and now?" },
      thread: long,
    });

    // What was said most recently is what the new message answers.
    expect(prompt).toContain("turn 29");
    expect(prompt).not.toContain("turn 0\n");
  });

  test("truncates a long turn rather than sending all of it", () => {
    const prompt = buildAddressingPrompt({
      candidates,
      message: { authorName: "Dominik", body: "x".repeat(2000) },
      thread: [],
    });

    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(1000);
  });
});
