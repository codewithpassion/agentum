import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { inboxThreads as threadRows } from "@repo/db/schema/inbox";
import { runRequests as requestRows } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import {
  teamMembers as teamMemberRows,
  teams as teamRows,
} from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import type { MemoryNote } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "../agents.ts";
import { seedAssignment, seedConnector } from "../connectors/test-seed.ts";
import { notFound } from "../errors.ts";
import { type Blobs, createEventsService } from "../events.ts";
import type { LibraryService } from "../library.ts";
import { serializeMemoryFile } from "../memory/codec.ts";
import { createRequestsService } from "../requests.ts";
import { importRunTokenKey, verifyAgentToken } from "../run-tokens.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import type { ProxyAccess } from "./fake-tool.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const BASE_URL = "https://app.example.test";
const CONNECTOR = "c1";
const TOOL = "search_docs";
const CONNECT_LINK = `${BASE_URL}/settings/apps/${CONNECTOR}/connect`;
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

type Db = ReturnType<typeof migrated>;
interface RpcBody {
  method: string;
  params?: { name?: string };
}

let db: Db;
let agents: AgentsService;
let runs: RunsService;
let requests: { auth: string | null; body: RpcBody; url: string }[];
let allowedTools: string[] | null;

const memoryBlobs = (): Blobs => {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, text) => {
      store.set(key, text);
      return Promise.resolve();
    },
  };
};

const rpc = (id: unknown, result: unknown) =>
  Response.json({ id, jsonrpc: "2.0", result });

/**
 * What the app's proxy answers, as far as the fake runtime can tell: a
 * connector with one tool, a sign-in only a person has, and an allow-list.
 */
const stubProxy: ProxyAccess = {
  baseUrl: BASE_URL,
  fetch: async (request) => {
    const body = (await request.json()) as RpcBody;
    const auth = request.headers.get("authorization");
    requests.push({ auth, body, url: request.url });
    const token = auth?.replace("Bearer ", "") ?? "";
    const verified = await verifyAgentToken({
      db,
      key: await importRunTokenKey(RUN_TOKEN_KEY),
      now: new Date(START),
      token,
    });
    if (!verified.ok) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const [run] = await db
      .select({ person: runRows.onBehalfOfUserId })
      .from(runRows)
      .where(eq(runRows.id, verified.claims.runId));
    if (run?.person === null) {
      return Response.json({
        error: {
          code: -32_000,
          data: { code: "needs_auth", connectPath: "/connect" },
          message: `This connector needs your login. Open ${CONNECT_LINK} while signed in to Agentum to connect it.`,
        },
        id: 1,
        jsonrpc: "2.0",
      });
    }
    if (body.method === "tools/call") {
      const name = body.params?.name ?? "";
      if (allowedTools && !allowedTools.includes(name)) {
        return Response.json(
          { error: "forbidden", reason: "tool_not_allowed" },
          { status: 403 }
        );
      }
      return rpc(1, {
        content: [{ text: "Workers KV is a store.", type: "text" }],
      });
    }
    if (body.method === "tools/list") {
      return rpc(1, {
        tools: [
          {
            inputSchema: {
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object",
            },
            name: TOOL,
          },
        ],
      });
    }
    return body.method.startsWith("notifications/")
      ? new Response(null, { status: 202 })
      : rpc(1, { protocolVersion: "2025-06-18" });
  },
};

const buildRuns = (
  proxy?: ProxyAccess,
  library?: Pick<LibraryService, "mkdir" | "pendingConflicts" | "read">
): RunsService => {
  const blobs = memoryBlobs();
  return createRunsService({
    adapters: [],
    atomic: sqliteAtomic(db),
    blobs,
    clock: { now: () => new Date(START), sleep: () => Promise.resolve() },
    db,
    devFakeRuntime: true,
    gateways: [],
    library,
    proxy,
    runTokenKey: RUN_TOKEN_KEY,
  });
};

/**
 * Runs and requests wired as the app wires them: the fake runtime opens its
 * approvals through a requests service that is built after the runs service.
 */
const buildAskable = () => {
  const blobs = memoryBlobs();
  const clock = { now: () => new Date(START), sleep: () => Promise.resolve() };
  const asking: RunsService = createRunsService({
    adapters: [],
    askApproval: async (request) => {
      await approvals.open(SYSTEM_PRINCIPAL, {
        ...request,
        input: {},
        kind: "approval",
      });
    },
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
  });
  const approvals = createRequestsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events: createEventsService({ blobs, db }),
    runs: asking,
    secrets: { maskerFor: () => Promise.resolve(null) },
  });
  return { approvals, asking };
};

/** An agent with the connector assigned, on the given model. */
const agentWithApp = async (model: string) => {
  const agent = await agents.create(user, {
    model,
    name: `Agent ${model}`,
    runtime: "fake",
  });
  await seedAssignment(db, {
    agentId: agent.id,
    allowedTools,
    connectorId: CONNECTOR,
    now: START,
    workspaceId: WORKSPACE,
  });
  return agent.id;
};

const runAs = async (principal: Principal, agentId: string, text: string) => {
  const started = await runs.startRun(principal, {
    agentId,
    input: { text },
    session: { origin: "ui" },
  });
  return {
    events: db
      .select()
      .from(eventRows)
      .where(eq(eventRows.runId, started.runId))
      .all(),
    summary: await runs.waitForRun(principal, started.runId, 5000),
  };
};

beforeEach(async () => {
  db = migrated();
  requests = [];
  allowedTools = null;
  const blobs = memoryBlobs();
  agents = createAgentsService({
    db,
    events: createEventsService({ blobs, db }),
  });
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  await seedConnector(db, {
    authKind: "oauth",
    id: CONNECTOR,
    name: "Docs",
    now: START,
    workspaceId: WORKSPACE,
  });
  runs = buildRuns(stubProxy);
});

test("a fake-tool run for a signed-in person calls the tool through the proxy with its own run token", async () => {
  const { events, summary } = await runAs(
    user,
    await agentWithApp("fake-tool"),
    "workers kv"
  );

  expect(summary).toMatchObject({
    resultText: `Used ${TOOL}: Workers KV is a store.`,
    status: "done",
  });
  expect(requests.map((request) => request.body.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
  expect(requests[0]?.url).toBe(`${BASE_URL}/api/proxy/${CONNECTOR}`);
  const types = events.map((event) => event.type);
  expect(types).toContain("tool.call");
  expect(types).toContain("tool.result");
  expect(types).toContain("message.assistant");
});

test("a run with no person behind it gets the connect link", async () => {
  const { summary } = await runAs(
    SYSTEM_PRINCIPAL,
    await agentWithApp("fake-tool"),
    "workers kv"
  );

  expect(summary.status).toBe("done");
  expect(summary.resultText).toContain(CONNECT_LINK);
});

test("a tool outside the allow-list is refused", async () => {
  allowedTools = [TOOL];
  const { events, summary } = await runAs(
    user,
    await agentWithApp("m"),
    "tool:delete_everything now"
  );

  expect(summary.resultText).toContain("delete_everything");
  expect(summary.resultText).toContain("not on this agent's allowed tools");
  expect(
    events.some(
      (event) =>
        event.type === "tool.result" && event.payload?.includes('"ok":false')
    )
  ).toBe(true);
});

test("a plain fake run still echoes", async () => {
  const { summary } = await runAs(user, await agentWithApp("m"), "hello");

  expect(summary.resultText).toBe("Echo: hello");
  expect(requests).toEqual([]);
});

test("a tool run without a proxy fails with a line saying so", async () => {
  runs = buildRuns();
  const { summary } = await runAs(user, await agentWithApp("fake-tool"), "hi");

  expect(summary.status).toBe("failed");
});

const MEMORY_PREFIX = /^.*\/memory\//;

const note = (text: string): MemoryNote => ({
  date: "2026-11-20",
  id: "01HZ7KQ3M8V2X4R6T9B1C50001",
  kind: "work",
  source: null,
  text,
  userScope: null,
  writtenBy: "person",
});

/**
 * A library holding the given files under the agent's memory folder, keyed by
 * the path after `memory/`. It stubs only what the fake runtime reads, so the
 * one cast stands in for the rest of the library service.
 */
const libraryWith = (files: Record<string, string>) =>
  ({
    mkdir: () => Promise.resolve(),
    pendingConflicts: () => Promise.resolve([]),
    read: (_principal: Principal, path: string) => {
      const text = files[path.replace(MEMORY_PREFIX, "")];
      return text === undefined
        ? Promise.reject(notFound("File"))
        : Promise.resolve({ bytes: new TextEncoder().encode(text) });
    },
  }) as unknown as Parameters<typeof buildRuns>[1];

const ana: Principal = { ...user, userId: "user_ana" };
const ben: Principal = { ...user, userId: "user_ben" };

test("a fake run lists the notes its prompt carried, so a person can see memory reached it", async () => {
  runs = buildRuns(
    undefined,
    libraryWith({
      "work.md": serializeMemoryFile("work.md", [
        note("Invoices go to Finance"),
      ]),
    })
  );
  const { summary } = await runAs(user, await agentWithApp("m"), "hello");

  expect(summary.resultText).toBe(
    "Echo: hello\n\nI remember:\n- Invoices go to Finance"
  );
});

test("a fake run with a library but no notes still echoes alone", async () => {
  runs = buildRuns(undefined, libraryWith({}));
  const { summary } = await runAs(user, await agentWithApp("m"), "hello");

  expect(summary.resultText).toBe("Echo: hello");
});

test("a private note reaches the run of its person and no one else's", async () => {
  const privateNote: MemoryNote = {
    ...note("Ana's locker is 12"),
    userScope: "user_ana",
  };
  runs = buildRuns(
    undefined,
    libraryWith({
      "private/user_ana.md": serializeMemoryFile("private/user_ana.md", [
        privateNote,
      ]),
    })
  );
  const agentId = await agentWithApp("m");

  const forAna = await runAs(ana, agentId, "hello");
  const forBen = await runAs(ben, agentId, "hello");

  expect(forAna.summary.resultText).toContain("Ana's locker is 12");
  expect(forBen.summary.resultText).toBe("Echo: hello");
});

test("a run whose memory cannot be read still echoes", async () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const failingRead = {
      mkdir: () => Promise.resolve(),
      pendingConflicts: () => Promise.resolve([]),
      read: () => Promise.reject(new Error("storage down")),
    } as unknown as Parameters<typeof buildRuns>[1];
    runs = buildRuns(undefined, failingRead);
    const { summary } = await runAs(user, await agentWithApp("m"), "hello");

    expect(summary).toMatchObject({
      resultText: "Echo: hello",
      status: "done",
    });
  } finally {
    log.mockRestore();
  }
});

test("a run whose memory loading throws before any read still echoes", async () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const brokenLibrary = {
      mkdir: () => Promise.resolve(),
      pendingConflicts: () => Promise.resolve([]),
      get read(): never {
        throw new Error("launch context down");
      },
    } as unknown as Parameters<typeof buildRuns>[1];
    runs = buildRuns(undefined, brokenLibrary);
    const { summary } = await runAs(user, await agentWithApp("m"), "hello");

    expect(summary).toMatchObject({
      resultText: "Echo: hello",
      status: "done",
    });
  } finally {
    log.mockRestore();
  }
});

test("a tool-mode run answers with the tool's result and lists no notes", async () => {
  runs = buildRuns(
    stubProxy,
    libraryWith({
      "work.md": serializeMemoryFile("work.md", [note("Not for a tool run")]),
    })
  );
  const { summary } = await runAs(
    user,
    await agentWithApp("fake-tool"),
    "workers kv"
  );

  expect(summary.resultText).toBe(`Used ${TOOL}: Workers KV is a store.`);
});

const askRun = async (text: string) => {
  const { approvals, asking } = buildAskable();
  const agent = await agents.create(user, {
    model: "m",
    name: "Ada",
    runtime: "fake",
  });
  const started = await asking.startRun(user, {
    agentId: agent.id,
    input: { text },
    session: { origin: "ui" },
  });
  return { approvals, asking, runId: started.runId };
};

const requestOf = async (runId: string) => {
  const [request] = await db
    .select()
    .from(requestRows)
    .where(eq(requestRows.runId, runId));
  return request;
};

test("an ask run opens an approval for the named tool and waits", async () => {
  const { asking, runId } = await askRun("@ada ask:send_email");

  const request = await requestOf(runId);
  expect(request).toMatchObject({
    kind: "approval",
    status: "pending",
    toolName: "send_email",
  });
  expect((await asking.waitForRun(user, runId, 0)).status).toBe("waiting");
});

test("allowing the approval ends the run with a reply that names the decision", async () => {
  const { approvals, asking, runId } = await askRun("ask:send_email");
  const request = await requestOf(runId);

  await approvals.answer(user, {
    answer: { decision: "allow_once" },
    requestId: request?.id ?? "",
    via: "web",
  });

  expect(await asking.waitForRun(user, runId, 5000)).toMatchObject({
    resultText: "Allowed send_email.",
    status: "done",
  });
});

test("denying the approval ends the run with a reply that says it was denied", async () => {
  const { approvals, asking, runId } = await askRun("ask:send_email");
  const request = await requestOf(runId);

  await approvals.answer(user, {
    answer: { decision: "deny" },
    requestId: request?.id ?? "",
    via: "web",
  });

  expect(await asking.waitForRun(user, runId, 5000)).toMatchObject({
    resultText: "Denied send_email.",
    status: "done",
  });
});

test("an ask run without a requests service fails with a line saying so", async () => {
  const agent = await agents.create(user, {
    model: "m",
    name: "Ada",
    runtime: "fake",
  });
  const { summary } = await runAs(user, agent.id, "ask:send_email");

  expect(summary.status).toBe("failed");
  expect(summary.error).toContain("requests service");
});

const TEAM = "team-1";
const THREAD = "thread-1";

interface McpCall {
  args: Record<string, unknown>;
  auth: string | null;
  name: string;
  url: string;
}

/**
 * A lead with one member agent in a team room, and a stand-in for the app's
 * `/mcp` route that records the calls a room run makes and answers as the
 * team tools would.
 */
const leadRoom = async () => {
  const lead = await agents.create(user, {
    model: "m",
    name: "Maya",
    runtime: "fake",
    slug: "maya",
  });
  const scout = await agents.create(user, {
    model: "m",
    name: "Scout",
    runtime: "fake",
    slug: "scout",
  });
  db.insert(teamRows)
    .values({
      createdAt: START,
      id: TEAM,
      leadAgentId: lead.id,
      name: "Support",
      slug: "support",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(teamMemberRows)
    .values({
      memberId: scout.id,
      memberKind: "agent",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(threadRows)
    .values({
      createdAt: START,
      createdBy: user.userId,
      id: THREAD,
      lastPostAt: START,
      teamId: TEAM,
      title: "Plans",
      workspaceId: WORKSPACE,
    })
    .run();
  const calls: McpCall[] = [];
  const mcp: ProxyAccess = {
    baseUrl: BASE_URL,
    fetch: async (request) => {
      const body = (await request.json()) as {
        params: { arguments: Record<string, unknown>; name: string };
      };
      const { name } = body.params;
      calls.push({
        args: body.params.arguments,
        auth: request.headers.get("authorization"),
        name,
        url: request.url,
      });
      const members = {
        members: [
          { handle: "maya", id: lead.id, isLead: true, kind: "agent" },
          { handle: "scout", id: scout.id, isLead: false, kind: "agent" },
        ],
      };
      const answers: Record<string, unknown> = {
        team_members: members,
        team_post: { post: { id: "p1" }, runs: [] },
        team_propose_change: { agentId: scout.id, field: "model" },
      };
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: {
          content: [{ text: `${name} done`, type: "text" }],
          structuredContent: answers[name],
        },
      });
    },
  };
  const leadRuns = buildRuns(mcp);
  const run = async (text: string) => {
    const started = await leadRuns.startRun(user, {
      agentId: lead.id,
      input: { text },
      session: { externalKey: THREAD, origin: "inbox" },
    });
    return {
      events: db
        .select()
        .from(eventRows)
        .where(eq(eventRows.runId, started.runId))
        .all(),
      summary: await leadRuns.waitForRun(user, started.runId, 5000),
    };
  };
  return { calls, run, scout };
};

test("a lead's room run with assign:handle posts to the room through /mcp with its run token", async () => {
  const { calls, run } = await leadRoom();

  const { events, summary } = await run("@maya sort out billing assign:scout");

  expect(summary).toMatchObject({
    resultText: "Assigned this to scout.",
    status: "done",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    args: { text: "@scout Please take this: sort out billing", topic: THREAD },
    name: "team_post",
    url: `${BASE_URL}/mcp`,
  });
  expect(calls[0]?.auth).toStartWith("Bearer ");
  const types = events.map((event) => event.type);
  expect(types).toContain("tool.call");
  expect(types).toContain("tool.result");
  expect(types).toContain("message.assistant");
});

test("team_propose_change:<field>=<value> reads the members, then proposes to the named one", async () => {
  const { calls, run, scout } = await leadRoom();

  const { summary } = await run(
    "@maya team_propose_change:effort=high for @scout"
  );

  expect(summary.status).toBe("done");
  expect(calls.map((call) => call.name)).toEqual([
    "team_members",
    "team_propose_change",
  ]);
  expect(calls[1]?.args).toMatchObject({
    agentId: scout.id,
    field: "effort",
    value: "high for @scout",
  });
});

test("a lead's room run without a marker still echoes", async () => {
  const { calls, run } = await leadRoom();

  const { summary } = await run("hello");

  expect(summary.resultText).toBe("Echo: hello");
  expect(calls).toEqual([]);
});

test("a marker outside a lead's room run echoes and calls no team tool", async () => {
  const { calls } = await leadRoom();
  const agent = await agents.create(user, {
    model: "m",
    name: "Ada",
    runtime: "fake",
  });

  const { summary } = await runAs(user, agent.id, "assign:@scout");

  expect(summary.resultText).toBe("Echo: assign:@scout");
  expect(calls).toEqual([]);
});

test("markers in the earlier posts after the wake tail do not trigger the lead", async () => {
  const { calls, run } = await leadRoom();

  const { summary } = await run(
    "hello\n\nYour final answer is your reply. Earlier: assign:@scout"
  );

  expect(summary.resultText).toContain("Echo: hello");
  expect(calls).toEqual([]);
});
