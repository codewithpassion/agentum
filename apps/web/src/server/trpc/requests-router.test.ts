import { expect, test } from "bun:test";
import type { Context } from "./context.ts";
import { requestsRouter } from "./requests-router.ts";

const principal = { kind: "user", userId: "u", workspaceId: "w", via: "session" } as const;
test("each requests procedure makes one service call with validated input", async () => {
  const calls: unknown[] = [];
  const record = async (...args: unknown[]) => { calls.push(args); return []; };
  const caller = requestsRouter.createCaller({ principal, services: { requests: { listPending: record, answer: record, listRules: record, setRule: record, removeRule: record } } } as unknown as Context);
  await caller.pending({});
  await caller.answer({ requestId: "r", decision: "deny", note: "no" });
  await caller.answer({ requestId: "q", answers: { Why: "yes" } });
  await caller.rules.list({ agentId: "a" });
  await caller.rules.set({ agentId: "a", toolKey: "bash", mode: "ask" });
  await caller.rules.remove({ agentId: "a", toolKey: "bash" });
  expect(calls).toEqual([
    [principal, {}],
    [principal, { requestId: "r", answer: { decision: "deny", note: "no" }, via: "web" }],
    [principal, { requestId: "q", answer: { answers: { Why: "yes" } }, via: "web" }],
    [principal, { agentId: "a" }],
    [principal, { agentId: "a", toolKey: "bash", mode: "ask" }],
    [principal, { agentId: "a", toolKey: "bash" }],
  ]);
  await expect(caller.answer({ requestId: "r" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(caller.answer({ requestId: "r", decision: "deny", answers: {} } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(caller.rules.set({ agentId: "a", toolKey: "", mode: "ask" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(calls).toHaveLength(6);
});
