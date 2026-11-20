import { expect, test } from "bun:test";
import { ToolError } from "@repo/mcp/result";
import { ServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { createDecisionsPorts } from "./decisions-ports.ts";

const run: Extract<Principal, { kind: "run" }> = {
  agentId: "a",
  kind: "run",
  runId: "r",
  workspaceId: "w",
};
const questions = [
  { options: ["Yes", "No"], text: "Ship it?" },
  { freeText: true, options: ["Later", "Now"], text: "Which region?" },
];

/** A fake of the one service method the port calls, with the fields it reads. */
type FakeOpenDecisions = (
  principal: Principal,
  input: { questions: unknown; runId: string }
) => Promise<{ expiresAt: string; id: string }>;

const portsOver = (openDecisions: FakeOpenDecisions) =>
  createDecisionsPorts({
    principal: run,
    services: { requests: { openDecisions } } as unknown as Pick<
      Services,
      "requests"
    >,
  });

test("ask opens the decisions for the run and returns the count, request id and expiry", async () => {
  const calls: unknown[] = [];
  const ports = portsOver((principal, input) => {
    calls.push({ input, principal });
    return Promise.resolve({
      expiresAt: "2026-11-22T10:00:00.000Z",
      id: "req_1",
    });
  });

  const result = await ports.ask({ questions });

  expect(calls).toEqual([{ input: { questions, runId: "r" }, principal: run }]);
  expect(result).toEqual({
    count: 2,
    expiresAt: "2026-11-22T10:00:00.000Z",
    requestId: "req_1",
  });
});

test("a service conflict from openDecisions comes out as a ToolError with the same message", async () => {
  const message = "Run is not running";
  const ports = portsOver(() =>
    Promise.reject(new ServiceError("conflict", message))
  );

  const failure = await ports
    .ask({ questions })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ToolError);
  expect(failure).toMatchObject({ code: "conflict", message });
});
