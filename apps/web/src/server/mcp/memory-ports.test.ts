import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import type { MemoryChange } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createAgentumMcpServer } from "@repo/mcp/server";
import { connectClient, textOf } from "@repo/mcp/testing";
import { ServiceError } from "@repo/services/errors";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

let composed: Composed;
let user: Extract<Principal, { kind: "user" }>;
let agentId: string;

beforeEach(async () => {
  const db = migrated(["org_a"]);
  const store = new Map<string, string>();
  composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(), sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("Missing workspace");
  }
  user = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
  agentId = (
    await composed.services.agents.create(user, {
      model: "fake",
      name: "Memory agent",
      runtime: "fake",
    })
  ).id;
});

const start = (
  principal: Principal,
  target = agentId,
  privateSession = false
) =>
  composed.services.runs.startRun(principal, {
    agentId: target,
    input: { text: "memoryneedle" },
    session: { origin: "slack", private: privateSession },
  });
const asRun = (runId: string): Extract<Principal, { kind: "run" }> => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: user.workspaceId,
});

const connect = (principal: Principal) =>
  connectClient(
    createAgentumMcpServer(
      createMcpPorts({ principal, services: composed.services })
    )
  );

for (const status of ["applied", "held"] as const) {
  test(`memory service receives the run principal, own agent and run source (${status})`, async () => {
    const run = await start(user);
    const principal = asRun(run.runId);
    const calls: unknown[] = [];
    const change: MemoryChange = {
      action: "add",
      agentId,
      createdAt: "2026-11-20T00:00:00.000Z",
      decidedAt: null,
      decidedBy: null,
      dreamRunId: null,
      groupId: null,
      id: "change",
      kind: "work",
      libraryVersionId: null,
      noteId: "note",
      source: { id: run.runId, kind: "run" },
      status,
      text: "A fact",
      userScope: null,
      writtenBy: "agent",
    };
    composed.services.memory = {
      ...composed.services.memory,
      add: (caller, input) => {
        calls.push([caller, input]);
        return Promise.resolve(change);
      },
      forget: (caller, input) => {
        calls.push([caller, input]);
        return Promise.resolve({ ...change, action: "forget" });
      },
    };
    const { client, close } = await connect(principal);
    try {
      for (const [name, args] of [
        ["remember", { kind: "work", text: "A fact" }],
        ["forget_note", { id: "note" }],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: verify each tool before proceeding.
        const result = await client.callTool({ arguments: args, name });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
          changeId: "change",
          noteId: "note",
          status,
        });
      }
      expect(calls).toEqual([
        [
          principal,
          {
            agentId,
            kind: "work",
            source: { id: run.runId, kind: "run" },
            text: "A fact",
          },
        ],
        [principal, { agentId, noteId: "note" }],
      ]);
    } finally {
      await close();
    }
  });
}

test("peer-origin runs and their handoffs cannot remember or forget", async () => {
  const peer: Principal = {
    agentId,
    connectionId: "connection",
    kind: "peer",
    workspaceId: user.workspaceId,
  };
  const parent = await start(peer);
  const child = await start(asRun(parent.runId));
  for (const runId of [parent.runId, child.runId]) {
    // biome-ignore lint/performance/noAwaitInLoops: each run gets an independent MCP connection.
    const { client, close } = await connect(asRun(runId));
    try {
      for (const [name, args] of [
        ["remember", { kind: "work", text: "x" }],
        ["forget_note", { id: "note" }],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: verify each tool before proceeding.
        const result = await client.callTool({ arguments: args, name });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: "forbidden" });
      }
    } finally {
      await close();
    }
  }
  // The memory service refuses it, so nothing was recorded.
  expect(await composed.services.memory.changes(user, { agentId })).toEqual([]);
});

test("history searches only this agent's visible sessions and applies the limit", async () => {
  const own = await start(user, agentId, true);
  const shared = await start(user);
  const hidden = await start({ ...user, userId: "other" }, agentId, true);
  const otherAgent = await composed.services.agents.create(user, {
    model: "fake",
    name: "Other",
    runtime: "fake",
  });
  const other = await start(user, otherAgent.id);
  const { client, close } = await connect(asRun(own.runId));
  try {
    const result = await client.callTool({
      arguments: { limit: 20, query: "memoryneedle" },
      name: "search_history",
    });
    expect(result.isError).not.toBe(true);
    const { results } = result.structuredContent as {
      results: {
        session: { id: string; createdAt: string };
        passages: string[];
      }[];
    };
    expect(results.map((hit) => hit.session.id).sort()).toEqual(
      [own.sessionId, shared.sessionId].sort()
    );
    for (const hit of results) {
      expect(hit.passages.join(" ")).toContain("memoryneedle");
      expect(textOf(result)).toContain(hit.session.createdAt);
    }
    expect(textOf(result)).not.toContain(hidden.sessionId);
    expect(textOf(result)).not.toContain(other.sessionId);
    const limited = await client.callTool({
      arguments: { limit: 1, query: "memoryneedle" },
      name: "search_history",
    });
    expect(
      (limited.structuredContent as { results: unknown[] }).results
    ).toHaveLength(1);
  } finally {
    await close();
  }
});

test("non-run callers have no memory port; service errors are readable", async () => {
  expect(
    createMcpPorts({ principal: user, services: composed.services }).memory
  ).toBeUndefined();
  const run = await start(user);
  composed.services.memory.add = () =>
    Promise.reject(new ServiceError("invalid", "Cannot parse memory file"));
  const { client, close } = await connect(asRun(run.runId));
  try {
    const result = await client.callTool({
      arguments: { kind: "work", text: "x" },
      name: "remember",
    });
    expect(result.structuredContent).toMatchObject({ code: "validation" });
    expect(textOf(result)).toContain("Cannot parse memory file");
  } finally {
    await close();
  }
});

test("trusted runs without user delegation may remember; forged run agents cannot", async () => {
  const started = await start({ kind: "system" });
  const principal = asRun(started.runId);
  const port = createMcpPorts({
    principal,
    services: composed.services,
  }).memory;
  expect(
    await port?.remember({ kind: "work", text: "Trusted fact" })
  ).toMatchObject({
    status: "applied",
  });
  const forged = createMcpPorts({
    principal: { ...principal, agentId: "another-agent" },
    services: composed.services,
  }).memory;
  await expect(
    forged?.remember({ kind: "work", text: "Forbidden fact" })
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(
    await composed.services.memory.changes(user, { agentId })
  ).toHaveLength(1);
});

test("remember passes the never list refusal back to the agent", async () => {
  await composed.services.memory.rules.set(user, {
    agentId,
    rules: {
      dreamSchedule: "nightly",
      learnLevel: "tell_after",
      never: ["Salary"],
      remember: [],
      shareWithTeam: true,
    },
  });
  const run = await start(user);
  const { client, close } = await connect(asRun(run.runId));
  try {
    const refused = await client.callTool({
      arguments: { kind: "people", text: "Tom asked about his salary review" },
      name: "remember",
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "validation" });
    expect(textOf(refused)).toContain("never-remember list");
    expect(textOf(refused)).toContain('"Salary"');
    const changes = await composed.services.memory.changes(user, { agentId });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.status).toBe("rejected");
    expect(changes[0]?.text).not.toContain("Tom asked about his salary review");
    const kept = await client.callTool({
      arguments: { kind: "people", text: "Tom prefers calls" },
      name: "remember",
    });
    expect(kept.isError).not.toBe(true);
    expect(kept.structuredContent).toMatchObject({ status: "applied" });
    const notes = await composed.services.memory.list(user, { agentId });
    expect(notes.map((note) => note.text)).toEqual(["Tom prefers calls"]);
  } finally {
    await close();
  }
});
