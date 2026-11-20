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
  const workspace = await composed.services.workspaces.forOrg({ clerkOrgId: "org_a" });
  if (!workspace) {
    throw new Error("Missing workspace");
  }
  user = { kind: "user", userId: "user_1", via: "session", workspaceId: workspace.id };
  agentId = (await composed.services.agents.create(user, { model: "fake", name: "Memory agent", runtime: "fake" })).id;
});

const start = (principal: Principal, target = agentId, privateSession = false) =>
  composed.services.runs.startRun(principal, {
    agentId: target,
    input: { text: "memoryneedle" },
    session: { origin: "slack", private: privateSession },
  });
const asRun = (runId: string): Extract<Principal, { kind: "run" }> => ({ agentId, kind: "run", runId, workspaceId: user.workspaceId });

const connect = (principal: Principal) => connectClient(createAgentumMcpServer(createMcpPorts({ principal, services: composed.services })));

for (const status of ["applied", "held"] as const) {
  test(`memory service receives the run principal, own agent and run source (${status})`, async () => {
    const run = await start(user);
    const principal = asRun(run.runId);
    const calls: unknown[] = [];
    const change: MemoryChange = {
      action: "add", agentId, createdAt: "2026-11-20T00:00:00.000Z", decidedAt: null, decidedBy: null,
      dreamRunId: null, groupId: null, id: "change", kind: "work", libraryVersionId: null, noteId: "note",
      source: { id: run.runId, kind: "run" }, status, text: "A fact", userScope: null, writtenBy: "agent",
    };
    composed.services.memory = {
      ...composed.services.memory,
      add: (caller, input) => { calls.push([caller, input]); return Promise.resolve(change); },
      forget: (caller, input) => { calls.push([caller, input]); return Promise.resolve({ ...change, action: "forget" }); },
    };
    const { client, close } = await connect(principal);
    try {
      for (const [name, args] of [["remember", { kind: "work", text: "A fact" }], ["forget_note", { id: "note" }]] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ changeId: "change", noteId: "note", status });
      }
      expect(calls).toEqual([
        [principal, { agentId, kind: "work", text: "A fact", source: { kind: "run", id: run.runId } }],
        [principal, { agentId, noteId: "note" }],
      ]);
    } finally { await close(); }
  });
}

test("peer-origin runs and their handoffs cannot remember or forget", async () => {
  const peer: Principal = { agentId, connectionId: "connection", kind: "peer", workspaceId: user.workspaceId };
  const parent = await start(peer);
  const child = await start(asRun(parent.runId));
  composed.services.memory.add = () => { throw new Error("Peer reached memory.add"); };
  composed.services.memory.forget = () => { throw new Error("Peer reached memory.forget"); };
  for (const runId of [parent.runId, child.runId]) {
    const { client, close } = await connect(asRun(runId));
    try {
      for (const [name, args] of [["remember", { kind: "work", text: "x" }], ["forget_note", { id: "note" }]] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: "forbidden" });
        expect(textOf(result)).toContain("peer");
      }
    } finally { await close(); }
  }
});

test("history searches only this agent's visible sessions and applies the limit", async () => {
  const own = await start(user, agentId, true);
  const shared = await start(user);
  const hidden = await start({ ...user, userId: "other" }, agentId, true);
  const otherAgent = await composed.services.agents.create(user, { model: "fake", name: "Other", runtime: "fake" });
  const other = await start(user, otherAgent.id);
  const { client, close } = await connect(asRun(own.runId));
  try {
    const result = await client.callTool({ name: "search_history", arguments: { query: "memoryneedle", limit: 20 } });
    expect(result.isError).not.toBe(true);
    const results = (result.structuredContent as { results: { session: { id: string; createdAt: string }; passages: string[] }[] }).results;
    expect(results.map((hit) => hit.session.id).sort()).toEqual([own.sessionId, shared.sessionId].sort());
    for (const hit of results) {
      expect(hit.passages.join(" ")).toContain("memoryneedle");
      expect(textOf(result)).toContain(hit.session.createdAt);
    }
    expect(textOf(result)).not.toContain(hidden.sessionId);
    expect(textOf(result)).not.toContain(other.sessionId);
    const limited = await client.callTool({ name: "search_history", arguments: { query: "memoryneedle", limit: 1 } });
    expect((limited.structuredContent as { results: unknown[] }).results).toHaveLength(1);
  } finally { await close(); }
});

test("non-run callers have no memory port; service errors are readable", async () => {
  expect(createMcpPorts({ principal: user, services: composed.services }).memory).toBeUndefined();
  const run = await start(user);
  composed.services.memory.add = () => Promise.reject(new ServiceError("invalid", "Cannot parse memory file"));
  const { client, close } = await connect(asRun(run.runId));
  try {
    const result = await client.callTool({ name: "remember", arguments: { kind: "work", text: "x" } });
    expect(result.structuredContent).toMatchObject({ code: "validation" });
    expect(textOf(result)).toContain("Cannot parse memory file");
  } finally { await close(); }
});
