import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { requestsRouter } from "./requests-router.ts";

const principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
} as const;
test("each requests procedure makes one service call with validated input", async () => {
  const calls: unknown[] = [];
  const record = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve([]);
  };
  const caller = requestsRouter.createCaller({
    principal,
    services: {
      requests: {
        answer: record,
        listPending: record,
        listRules: record,
        removeRule: record,
        setRule: record,
      },
    },
  } as unknown as Context);
  await caller.pending({});
  await caller.answer({ decision: "deny", note: "no", requestId: "r" });
  await caller.answer({ answers: { Why: "yes" }, requestId: "q" });
  await caller.rules.list({ agentId: "a" });
  await caller.rules.set({ agentId: "a", mode: "ask", toolKey: "bash" });
  await caller.rules.remove({ agentId: "a", toolKey: "bash" });
  expect(calls).toEqual([
    [principal, {}],
    [
      principal,
      { answer: { decision: "deny", note: "no" }, requestId: "r", via: "web" },
    ],
    [
      principal,
      { answer: { answers: { Why: "yes" } }, requestId: "q", via: "web" },
    ],
    [principal, { agentId: "a" }],
    [principal, { agentId: "a", mode: "ask", toolKey: "bash" }],
    [principal, { agentId: "a", toolKey: "bash" }],
  ]);
  await expect(
    caller.answer({ requestId: "r" } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.answer({ answers: {}, decision: "deny", requestId: "r" } as never)
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    caller.rules.set({ agentId: "a", mode: "ask", toolKey: "" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(calls).toHaveLength(6);
});
