import { expect, test } from "bun:test";
import type { DecisionInput, DecisionsPort } from "../ports";
import { agentumTools } from "../server";
import { textOf } from "../testing";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const TOOL = "ask_decisions";
const REPLY = {
  count: 1,
  expiresAt: "2026-11-22T00:00:00.000Z",
  requestId: "request-1",
};

const decisionsPort = (
  received: { questions: DecisionInput[] }[] = []
): DecisionsPort => ({
  ask: (input) => {
    received.push(input);
    return Promise.resolve(REPLY);
  },
});

const offers = (list: readonly { name: string }[]) =>
  list.some((tool) => tool.name === TOOL);

const question = (overrides: Record<string, unknown> = {}) => ({
  options: ["Yes", "No"],
  text: "Ship it?",
  ...overrides,
});

test("offers no decisions tool when the port is unset", () => {
  expect(offers(agentumTools(fakePorts()))).toBe(false);
});

test("passes the trimmed questions to the port and shows its reply", async () => {
  const received: { questions: DecisionInput[] }[] = [];
  const result = await callTool(
    fakePorts({ decisions: decisionsPort(received) }),
    TOOL,
    {
      questions: [
        question({ options: [" Yes ", "No"], text: "  Ship it?  " }),
        question({ freeText: true, options: ["Now", "Later"], text: "When?" }),
      ],
    }
  );
  expect(result.isError).toBeFalsy();
  expect(received).toEqual([
    {
      questions: [
        { options: ["Yes", "No"], text: "Ship it?" },
        { freeText: true, options: ["Now", "Later"], text: "When?" },
      ],
    },
  ]);
  expect(textOf(result)).toBe(
    "Raised 1 decisions (request request-1). Do not wait for them: end your turn or carry on. Answers arrive as a new message here, one line per question, once all are answered or by 2026-11-22T00:00:00.000Z."
  );
  expect(result.structuredContent).toEqual(REPLY);
});

test("a read-only server does not offer the decisions tool", () => {
  const ports = fakePorts({ decisions: decisionsPort() });
  expect(offers(agentumTools(ports, { readOnly: true }))).toBe(false);
  expect(offers(agentumTools(ports))).toBe(true);
});

test("a team room server still offers the decisions tool", () => {
  const ports = fakePorts({ decisions: decisionsPort() });
  expect(offers(agentumTools(ports, { teamRoom: true }))).toBe(true);
});

test.each([
  [
    "nine questions",
    { questions: Array.from({ length: 9 }, () => question()) },
  ],
  ["one option", { questions: [question({ options: ["Only"] })] }],
  [
    "five options",
    { questions: [question({ options: ["a", "b", "c", "d", "e"] })] },
  ],
  ["an empty text", { questions: [question({ text: "   " })] }],
])("refuses %s before calling the port", async (_label, args) => {
  let calls = 0;
  const count = (): Promise<never> => {
    calls += 1;
    return Promise.reject(new Error("Unexpected port call"));
  };
  const result = await callTool(
    fakePorts({ decisions: { ask: count } }),
    TOOL,
    args
  );
  expect(result.isError).toBe(true);
  expect(calls).toBe(0);
});
