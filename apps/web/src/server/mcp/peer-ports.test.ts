import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { a2aConnections, a2aOutboundTasks } from "@repo/db/schema/a2a";
import { runs } from "@repo/db/schema/runs";
import { migrated } from "@repo/db/test-db";
import { createHarbourmasterMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import {
  createFakePeer,
  type FakePeer,
  PEER_ORIGIN,
  peerCard,
} from "../../../../../packages/services/src/a2a/outbound-fixture.ts";
import { SECRETS_KEY } from "../../../../../packages/services/src/a2a/tasks-fixture.ts";
import { type Composed, composeWith } from "../compose.ts";
import {
  createMcpPorts,
  resolveRunBrowser,
  resolveRunComputer,
} from "./ports.ts";

const PUBLIC_BASE_URL = "https://hm.test";
const CONNECTION_ID = "con_peer";
const PEER_TOOL_AGENT = "acme/helper";

let composed: Composed;
let db: Composed["db"];
let workspaceId: string;
let userPrincipal: Principal;
let fakePeer: FakePeer;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.now();
  fakePeer = createFakePeer();
  const database = migrated();
  db = database;
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db: database,
    infra: {
      atomic: sqliteAtomic(database),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: { now: () => new Date(nowMs), sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      peerFetch: fakePeer.fetch,
      publicBaseUrl: PUBLIC_BASE_URL,
      relay: noopRelay,
      secretsKey: SECRETS_KEY,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  userPrincipal = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId,
  };
});

/** An agent of the workspace, with a run that is still running. */
const agentWithRun = async (name: string, { running = true } = {}) => {
  const agent = await composed.services.agents.create(userPrincipal, {
    model: "fake",
    name,
    runtime: "fake",
  });
  const { runId } = await composed.services.runs.startRun(userPrincipal, {
    agentId: agent.id,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  if (running) {
    // The fake runtime finishes a run at once. A send that asks a person first needs the run still running.
    db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();
  }
  const principal: Principal = {
    agentId: agent.id,
    kind: "run",
    runId,
    workspaceId,
  };
  return { agent, principal };
};

/**
 * An active connection to the fake peer, owned by `agentId`. Its agent part is
 * the peer's label, `helper`. The credential is encrypted the way the app stores it.
 */
const insertPeer = async (
  agentId: string,
  overrides: Partial<typeof a2aConnections.$inferInsert> = {}
) => {
  const key = await importSecretsKey(SECRETS_KEY);
  const credential = await encryptSecret(
    key,
    {
      field: "outbound_credential",
      rowId: CONNECTION_ID,
      table: "a2a_connections",
      workspaceId,
    },
    "peer-secret"
  );
  db.insert(a2aConnections)
    .values({
      approvedAt: "2026-11-01T10:00:00.000Z",
      approvedBy: "user_1",
      createdAt: "2026-11-01T10:00:00.000Z",
      createdBy: "user_1",
      id: CONNECTION_ID,
      localAgentId: agentId,
      outboundCredential: credential,
      outboundPolicy: "auto",
      outboundScheme: "bearer",
      peerCard: JSON.stringify(peerCard()),
      peerCardUrl: `${PEER_ORIGIN}/.well-known/agent-card.json`,
      peerKind: "a2a_outbound",
      peerLabel: "Helper",
      peerOrigin: PEER_ORIGIN,
      slug: "acme",
      status: "active",
      workspaceId,
      ...overrides,
    })
    .run();
};

/** An MCP session the way `/mcp` builds one for `principal`. */
const connect = async (
  principal: Principal,
  options: {
    dryRun?: {
      record: (skip: { summary: string; tool: string }) => Promise<void>;
    };
  } = {}
) => {
  const computer = await resolveRunComputer(composed.services, principal);
  const ports = createMcpPorts({
    computerMachineId: computer?.machineId,
    principal,
    relay: composed.relay,
    services: composed.services,
  });
  const server = createHarbourmasterMcpServer(ports, {
    browser: await resolveRunBrowser(composed.services, principal),
    computer: computer ? { desktop: computer.desktop } : undefined,
    dryRun: options.dryRun,
  });
  const { client, close } = await connectClient(server);
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ arguments: args, name }),
    close,
  };
};

type ToolResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof connect>>["call"]>
>;

const textOf = (result: ToolResult): string => {
  const [first] = result.content as Array<{ text?: unknown }>;
  return typeof first?.text === "string" ? first.text : "";
};

/** A key of the workspace, as the `/mcp` route sees a bearer key. */
const apiKeyPrincipal = (access: "read" | "write"): Principal => ({
  apiKey: { access, id: "key_1" },
  kind: "user",
  userId: "user_1",
  via: "api_key",
  workspaceId,
});

const sentMessages = () =>
  fakePeer.calls.filter((call) => call.method === "SendMessage");

test("list_agents for the owning run lists the local agents and the peer", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const session = await connect(principal);
  const result = await session.call("list_agents", {});
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    agents: expect.arrayContaining([
      expect.objectContaining({ id: agent.id, slug: agent.slug }),
      expect.objectContaining({
        description: "A fake peer",
        host: "peer.test",
        peer: true,
        slug: PEER_TOOL_AGENT,
      }),
    ]),
  });
  expect(textOf(result)).toContain(`${PEER_TOOL_AGENT}: peer at peer.test`);
  expect(textOf(result)).toContain("peer at peer.test");
  await session.close();
});

test("list_agents for another agent's run in the same workspace shows no peer", async () => {
  const ada = await agentWithRun("Ada");
  const grace = await agentWithRun("Grace");
  await insertPeer(ada.agent.id);
  const session = await connect(grace.principal);
  const result = await session.call("list_agents", {});
  expect(result.isError).toBeFalsy();
  const { agents } = result.structuredContent as {
    agents: Array<{ peer?: boolean; slug: string }>;
  };
  expect(agents.some((entry) => entry.peer === true)).toBe(false);
  expect(agents.map((entry) => entry.slug).sort()).toEqual(
    [ada.agent.slug, grace.agent.slug].sort()
  );
  expect(textOf(result)).not.toContain(PEER_TOOL_AGENT);
  await session.close();
});

/** What `list_agents` answers to `principal`. */
const listFor = async (principal: Principal) => {
  const session = await connect(principal);
  const result = await session.call("list_agents", {});
  await session.close();
  return result;
};

test("list_agents for an API key lists the local agents only", async () => {
  const { agent } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const result = await listFor(apiKeyPrincipal("read"));
  expect(result.isError).toBeFalsy();
  const { agents } = result.structuredContent as {
    agents: Array<{ peer?: boolean; slug: string }>;
  };
  expect(agents.some((entry) => entry.peer === true)).toBe(false);
  expect(agents.map((entry) => entry.slug)).toEqual([agent.slug]);
  expect(textOf(result)).not.toContain(PEER_TOOL_AGENT);
});

test("list_agents for a person lists the local agents only", async () => {
  const { agent } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const result = await listFor(userPrincipal);
  expect(result.isError).toBeFalsy();
  const { agents } = result.structuredContent as {
    agents: Array<{ peer?: boolean; slug: string }>;
  };
  expect(agents.some((entry) => entry.peer === true)).toBe(false);
  expect(agents.map((entry) => entry.slug)).toEqual([agent.slug]);
  expect(textOf(result)).not.toContain(PEER_TOOL_AGENT);
});

test("send_message to a peer on auto sends once, and get_run follows it to the answer", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const session = await connect(principal);

  const sent = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "What is six times seven?",
  });
  expect(sent.isError).toBeFalsy();
  const { runId } = sent.structuredContent as { runId: string };
  expect(runId.startsWith("aot_")).toBe(true);
  expect(sent.structuredContent).toMatchObject({
    state: "pending",
    status: "running",
  });
  expect(sentMessages()).toHaveLength(1);

  const polled = await session.call("get_run", { runId });
  expect(polled.isError).toBeFalsy();
  expect(polled.structuredContent).toMatchObject({
    runId,
    state: "pending",
    status: "running",
  });

  const [remoteTaskId] = [...fakePeer.tasks.keys()];
  if (!remoteTaskId) {
    throw new Error("the fake peer holds no task");
  }
  fakePeer.finish(remoteTaskId, "42");
  // `get` asks the peer again only when the row is more than 5 s old.
  nowMs += 10_000;

  const done = await session.call("get_run", { runId });
  expect(done.isError).toBeFalsy();
  expect(done.structuredContent).toMatchObject({ runId, state: "done" });
  expect((done.structuredContent as { answer: string }).answer).toContain("42");
  expect(sentMessages()).toHaveLength(1);
  await session.close();
});

test("send_message to a peer on approve waits for a person and sends nothing", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id, { outboundPolicy: "approve" });
  const session = await connect(principal);

  const sent = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "Please check this.",
  });
  expect(sent.isError).toBeFalsy();
  expect(sent.structuredContent).toMatchObject({
    state: "pending",
    status: "waiting",
  });
  expect(textOf(sent)).toContain("Waiting for a person to approve");
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});

test("send_message to a peer whose policy is off is refused", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id, { outboundPolicy: "off" });
  const session = await connect(principal);

  const result = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "Hello?",
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("Sending to this peer is turned off.");
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});

test("send_message to a revoked peer is an error and sends nothing", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id, { status: "revoked" });
  const session = await connect(principal);

  const result = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "Hello?",
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("This connection is not active.");
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});

test("send_message to a wrong agent part of a live peer is not found and sends nothing", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const session = await connect(principal);

  const result = await session.call("send_message", {
    agent: "acme/someone-else",
    text: "Hello?",
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "not_found" });
  expect(fakePeer.calls).toHaveLength(0);
  expect(db.select().from(a2aOutboundTasks).all()).toHaveLength(0);
  await session.close();
});

/** What `send_message` to the peer answers to `principal`. */
const sendAs = async (principal: Principal) => {
  const session = await connect(principal);
  const result = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "Hello?",
  });
  await session.close();
  return result;
};

test("send_message to a peer from an API key is not found and calls no peer", async () => {
  const { agent } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const result = await sendAs(apiKeyPrincipal("write"));
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "not_found" });
  expect(textOf(result)).toContain("No agent");
  expect(fakePeer.calls).toHaveLength(0);
});

test("send_message to a peer from a person is not found and calls no peer", async () => {
  const { agent } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const result = await sendAs(userPrincipal);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "not_found" });
  expect(textOf(result)).toContain("No agent");
  expect(fakePeer.calls).toHaveLength(0);
});

test("a dry run skips send_message to a peer and calls no peer", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  if (principal.kind !== "run") {
    throw new Error("expected a run principal");
  }
  const dryRunPrincipal: Principal = { ...principal, dryRun: true };
  const skipped: Array<{ summary: string; tool: string }> = [];
  const session = await connect(dryRunPrincipal, {
    dryRun: {
      record: (skip) => {
        skipped.push(skip);
        return Promise.resolve();
      },
    },
  });

  const result = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "Hello?",
  });
  expect(result.structuredContent).toMatchObject({
    skipped: true,
    tool: "send_message",
  });
  expect(skipped.map((skip) => skip.tool)).toEqual(["send_message"]);
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});

test("send_message and get_run to a local agent still run locally and never touch a peer", async () => {
  const ada = await agentWithRun("Ada", { running: false });
  const grace = await composed.services.agents.create(userPrincipal, {
    model: "fake",
    name: "Grace",
    runtime: "fake",
  });
  await insertPeer(ada.agent.id);
  const session = await connect(ada.principal);

  const sent = await session.call("send_message", {
    agent: grace.slug,
    text: "Hello, Grace.",
  });
  expect(sent.isError).toBeFalsy();
  const { runId } = sent.structuredContent as { runId: string };
  expect(runId.startsWith("aot_")).toBe(false);

  const polled = await session.call("get_run", { runId });
  expect(polled.isError).toBeFalsy();
  expect(polled.structuredContent).toMatchObject({ runId });
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});

test("send_message to a peer with waitMs on approve returns pending after about that long", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id, { outboundPolicy: "approve" });
  const session = await connect(principal);

  const started = Date.now();
  const result = await session.call("send_message", {
    agent: PEER_TOOL_AGENT,
    text: "Please check this.",
    waitMs: 50,
  });
  const elapsed = Date.now() - started;
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ state: "pending" });
  expect(elapsed).toBeGreaterThanOrEqual(40);
  expect(elapsed).toBeLessThan(2000);
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});

test("send_message past the hourly limit is a tool error that says when to retry", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id, { hourlyLimit: 0 });
  const result = await sendAs(principal);
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("hourly limit");
  expect(textOf(result)).toContain("Try again in about");
  expect(fakePeer.calls).toHaveLength(0);
});

test("send_message names a peer by its whole slug, so the connection id with another agent part is not found", async () => {
  const { agent, principal } = await agentWithRun("Ada");
  await insertPeer(agent.id);
  const session = await connect(principal);
  const result = await session.call("send_message", {
    agent: `${CONNECTION_ID}/anything`,
    text: "Hello?",
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ code: "not_found" });
  expect(fakePeer.calls).toHaveLength(0);
  await session.close();
});
