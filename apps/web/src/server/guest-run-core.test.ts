import { expect, test } from "bun:test";
import type { RequestOutcome } from "@repo/protocol/requests";
import type { RunRecord } from "@repo/services/runs/types";
import {
  createGuestRunCore,
  type GuestExecutionState,
  type GuestRunCoreDeps,
} from "./guest-run-core";

const fixture = () => {
  let state: GuestExecutionState | undefined;
  let outcome: RequestOutcome | null = null;
  let now = 1000;
  let reply: unknown = { kind: "answer", text: "done" };
  let inferenceCalls = 0;
  const effects: string[] = [];
  const run: RunRecord = {
    accessScope: null,
    actor: { id: "guest", kind: "guest" },
    agentId: "agent",
    claimedBy: "system",
    createdAt: new Date(0).toISOString(),
    depth: 0,
    dryRun: false,
    error: null,
    finishedAt: null,
    id: "r",
    inputFileIds: [],
    inputText: "trusted envelope",
    leaseUntil: new Date(2000).toISOString(),
    model: null,
    onBehalfOfUserId: null,
    outputFileIds: [],
    parentRunId: null,
    pendingFiles: null,
    processEndedAt: null,
    reply: { kind: "none" },
    requestId: null,
    resultText: null,
    scopeArtifactId: "artifact",
    sessionId: "shared-session",
    startedAt: new Date(0).toISOString(),
    status: "running",
    subagentLevel: 0,
    usage: null,
    workspaceId: "workspace",
  };
  const deps: GuestRunCoreDeps = {
    claim: () => Promise.resolve(true),
    complete: () => Promise.resolve(),
    execution: () => Promise.resolve({ model: "configured", run }),
    heartbeat: () => Promise.resolve(),
    infer: () => {
      inferenceCalls += 1;
      return Promise.resolve(reply);
    },
    ingest: () => Promise.resolve(),
    invoke: (_run, _name, _input, id) => {
      effects.push(id);
      return Promise.resolve({ ok: true });
    },
    now: () => now,
    open: () => Promise.resolve({ id: "request" }),
    outcome: () => Promise.resolve(outcome),
    store: {
      alarm: () => Promise.resolve(),
      get: () => Promise.resolve(state && structuredClone(state)),
      put: (next) => {
        state = structuredClone(next);
        return Promise.resolve();
      },
    },
    tools: () => Promise.resolve([{ inputSchema: {}, name: "document_read" }]),
  };
  return {
    advance: () => {
      now = 3000;
    },
    answer: () => {
      outcome = { answer: { decision: "allow_once" }, status: "answered" };
    },
    calls: () => inferenceCalls,
    core: () => createGuestRunCore(deps),
    deps,
    effects,
    reply: (value: unknown) => {
      reply = value;
    },
    run,
    state: () => state,
  };
};
test("expired guest execution lease cannot be revived by recovery heartbeat", async () => {
  const f = fixture();
  await f.core().start("r");
  f.advance();
  await expect(f.core().step()).rejects.toThrow("lease expired");
  expect(f.calls()).toBe(0);
  expect(f.effects).toHaveLength(0);
});
test("restricted inference cannot request a native or foreign-artifact capability", async () => {
  const f = fixture();
  await f.core().start("r");
  f.reply({
    input: { artifactId: "artifact", command: "env" },
    kind: "tool",
    name: "bash",
  });
  await expect(f.core().step()).rejects.toThrow("scope refused");
  f.reply({
    input: { artifactId: "other" },
    kind: "tool",
    name: "document_read",
  });
  await expect(f.core().step()).rejects.toThrow("scope refused");
  expect(f.effects).toHaveLength(0);
  expect(f.state()?.pending).toBeUndefined();
});
test("persisted approval survives reconstruction and uses a stable durable step", async () => {
  const f = fixture();
  await f.core().start("r");
  f.reply({
    input: { artifactId: "artifact" },
    kind: "tool",
    name: "document_read",
  });
  await f.core().step();
  await f.core().step();
  expect(f.state()?.requestId).toBe("request");
  expect(f.calls()).toBe(1);
  await f.core().step();
  expect(f.effects).toHaveLength(0);
  f.answer();
  await f.core().step();
  await f.core().step();
  expect(f.effects).toEqual(["r:0"]);
  expect(f.state()?.turn).toBe(1);
  f.reply({ kind: "answer", text: "done" });
  await f.core().step();
  await f.core().step();
  expect(f.state()?.phase).toBe("done");
  expect(f.calls()).toBe(2);
});

test("an older active run leaves guest work durably queued without inference or failure", async () => {
  const f = fixture();
  f.run.status = "queued";
  f.deps.claim = () => Promise.resolve(false);
  await f.core().start("r");
  await f.core().step();
  await f.core().step();
  expect(f.calls()).toBe(0);
  expect(f.state()?.phase).toBe("model");
  expect(f.state()?.failures).toBeUndefined();
});
