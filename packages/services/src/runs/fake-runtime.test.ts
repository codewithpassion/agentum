import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
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

/** A library holding the given files under the agent's memory folder, keyed by the path after `memory/`. */
const libraryWith = (files: Record<string, string>) => ({
  mkdir: () => Promise.resolve(),
  pendingConflicts: () => Promise.resolve([]),
  read: (_principal: Principal, path: string) => {
    const text = files[path.replace(MEMORY_PREFIX, "")];
    return text === undefined
      ? Promise.reject(notFound("File"))
      : Promise.resolve({ bytes: new TextEncoder().encode(text) });
  },
});

test("a fake run lists the notes its prompt carried, so a person can see memory reached it", async () => {
  runs = buildRuns(
    undefined,
    libraryWith({
      "work.md": serializeMemoryFile("work.md", [
        note("Invoices go to Finance"),
      ]),
    }) as never
  );
  const { summary } = await runAs(user, await agentWithApp("m"), "hello");

  expect(summary.resultText).toBe(
    "Echo: hello\n\nI remember:\n- Invoices go to Finance"
  );
});

test("a fake run with a library but no notes still echoes alone", async () => {
  runs = buildRuns(undefined, libraryWith({}) as never);
  const { summary } = await runAs(user, await agentWithApp("m"), "hello");

  expect(summary.resultText).toBe("Echo: hello");
});
