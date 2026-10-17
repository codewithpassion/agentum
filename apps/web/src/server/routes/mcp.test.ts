import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { importRunTokenKey, signRunToken } from "@repo/services/run-tokens";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import {
  OAuthVerificationUnavailableError,
  type VerifiedOAuthToken,
} from "../mcp/clerk-oauth.ts";
import type { AppEnv } from "./groups.ts";
import { MAX_MCP_BODY_BYTES, mcpRoutes } from "./mcp.ts";

const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const env = {
  ALLOWED_ORG_IDS: "org_a",
  PUBLIC_BASE_URL: "https://harbourmaster.example.com",
  RUN_TOKEN_KEY,
} as unknown as Env;
const MCP_URL = "https://harbourmaster.example.com/mcp";
const MINUTE_MS = 60_000;

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceId: string;
let members: Set<string>;
let oauthTokens: Map<string, VerifiedOAuthToken>;
let clerkDown: boolean;
let clientNameCalls: string[];
let logs: Record<string, unknown>[];
let app: Hono<AppEnv>;
let agentA: string;
let agentB: string;

const sessionUser = (userId: string): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

const createAgent = async (slug: string): Promise<string> => {
  const agent = await composed.services.agents.create(sessionUser("u1"), {
    model: "fake",
    name: slug,
    runtime: "fake",
    slug,
  });
  return agent.id;
};

const mintKey = async (userId: string, access: "read" | "write") =>
  (
    await composed.services.apiKeys.create(sessionUser(userId), {
      access,
      name: `${userId} key`,
    })
  ).secret;

/** A run row in `status`, as if a daemon were running it. */
const addRun = ({
  agentId,
  depth = 0,
  id,
  onBehalfOfUserId,
  origin = "mcp",
  parentRunId = null,
  status = "running",
}: {
  agentId: string;
  depth?: number;
  id: string;
  onBehalfOfUserId: string | null;
  origin?: "mcp" | "ui";
  parentRunId?: string | null;
  status?: "running" | "done";
}) => {
  const now = new Date();
  const sessionId = `session_${id}`;
  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: now.toISOString(),
      externalKey: sessionId,
      id: sessionId,
      origin,
      workspaceId,
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: now.toISOString(),
      depth,
      id,
      inputText: "work",
      leaseUntil: new Date(now.getTime() + 5 * MINUTE_MS).toISOString(),
      onBehalfOfUserId,
      parentRunId,
      sessionId,
      status,
      workspaceId,
    })
    .run();
};

const runToken = async (runId: string, agentId: string) =>
  signRunToken(await importRunTokenKey(RUN_TOKEN_KEY), {
    agentId,
    issuedAt: Date.now(),
    runId,
    workspaceId,
  });

const rpcBody = (method: string, params: unknown) =>
  JSON.stringify({ id: 1, jsonrpc: "2.0", method, params });

/** The JSON-RPC result of a POST, whether the handler answered JSON or an event stream. */
const readRpc = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return JSON.parse(data);
  }
  return JSON.parse(text);
};

const HOST = "harbourmaster.example.com";

const post = (token: string | null, body: string, host = HOST) =>
  app.request(
    MCP_URL,
    {
      body,
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Host: host,
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      method: "POST",
    },
    env
  );

interface ToolResult {
  content?: { text?: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const callTool = async (
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> => {
  const response = await post(
    token,
    rpcBody("tools/call", { arguments: args, name })
  );
  if (response.status !== 200) {
    throw new Error(`status ${response.status}: ${await response.text()}`);
  }
  const rpc = (await readRpc(response)) as { result: ToolResult };
  return rpc.result;
};

beforeEach(async () => {
  db = migrated();
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
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
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
      runTokenKey: RUN_TOKEN_KEY,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a is not an allowed organisation");
  }
  workspaceId = workspace.id;
  members = new Set(["u1@org_a", "u2@org_a"]);
  oauthTokens = new Map();
  clerkDown = false;
  clientNameCalls = [];
  logs = [];
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    "/mcp",
    mcpRoutes({
      clientName: () => (clientId) => {
        clientNameCalls.push(clientId);
        return Promise.resolve(`App ${clientId}`);
      },
      defer: (_c, work) => {
        pendingWork.push(work);
      },
      dev: false,
      isOrgMember: () => (userId, clerkOrgId) =>
        Promise.resolve(members.has(`${userId}@${clerkOrgId}`)),
      log: (entry) => logs.push(entry),
      verifyOAuthToken: () => (token) => {
        if (clerkDown) {
          return Promise.reject(
            new OAuthVerificationUnavailableError("status 503")
          );
        }
        return Promise.resolve(oauthTokens.get(token) ?? null);
      },
    })
  );
  pendingWork = [];
  agentA = await createAgent("agent-a");
  agentB = await createAgent("agent-b");
});

let pendingWork: Promise<unknown>[] = [];

describe("authentication", () => {
  test("a request without a credential, or with an unknown key, gets 401", async () => {
    const list = rpcBody("tools/list", {});
    expect((await post(null, list)).status).toBe(401);
    expect((await post("hm_key_nope", list)).status).toBe(401);
    expect((await post("not-an-hm-token", list)).status).toBe(401);
  });

  test("an api key whose user left the org gets 401", async () => {
    const key = await mintKey("u1", "write");
    const list = rpcBody("tools/list", {});
    expect((await post(key, list)).status).toBe(200);

    members.delete("u1@org_a");
    expect((await post(key, list)).status).toBe(401);
  });

  test("a revoked key gets 401", async () => {
    const created = await composed.services.apiKeys.create(sessionUser("u1"), {
      access: "write",
      name: "k",
    });
    await composed.services.apiKeys.revoke(sessionUser("u1"), created.key.id);
    expect((await post(created.secret, rpcBody("tools/list", {}))).status).toBe(
      401
    );
  });

  test("a machine credential is refused with 403", async () => {
    const { hash, token } = await import("@repo/services/crypto").then(
      (crypto) => crypto.hashedToken("hm_mach_")
    );
    const { machines } = await import("@repo/db/schema/machines");
    db.insert(machines)
      .values({
        capabilities: "[]",
        createdAt: new Date().toISOString(),
        credentialHash: hash,
        enrolledBy: "u1",
        id: "m1",
        name: "m1",
        singleUser: false,
        status: "online",
        workspaceId,
      })
      .run();
    expect((await post(token, rpcBody("tools/list", {}))).status).toBe(403);
  });

  test("a host other than PUBLIC_BASE_URL's is refused", async () => {
    const key = await mintKey("u1", "write");
    const response = await post(
      key,
      rpcBody("tools/list", {}),
      "evil.example.net"
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(401);
  });

  test("a body over 1 MB is refused with 413", async () => {
    const key = await mintKey("u1", "write");
    const response = await post(key, "x".repeat(MAX_MCP_BODY_BYTES + 1));
    expect(response.status).toBe(413);
  });

  test("a body that is not JSON is answered by the handler, not a crash", async () => {
    const key = await mintKey("u1", "write");
    const response = await post(key, "not json");
    expect(response.status).toBe(400);
  });

  test("an api key use is recorded in last_used_at", async () => {
    const created = await composed.services.apiKeys.create(sessionUser("u1"), {
      access: "read",
      name: "k",
    });
    await post(created.secret, rpcBody("tools/list", {}));
    await Promise.all(pendingWork);
    const [key] = await composed.services.apiKeys.list(sessionUser("u1"));
    expect(key?.lastUsedAt).not.toBeNull();
  });
});

describe("tools with an api key", () => {
  test("lists the ten platform tools and the list tools for a read key", async () => {
    const key = await mintKey("u1", "read");
    const response = await post(key, rpcBody("tools/list", {}));
    const rpc = (await readRpc(response)) as {
      result: { tools: { name: string }[] };
    };
    expect(rpc.result.tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "get_run",
      "inbox_list",
      "inbox_post",
      "inbox_read",
      "list_agents",
      "list_routines",
      "list_sessions",
      "list_triggers",
      "read_session",
      "search_sessions",
      "send_message",
    ]);
  });

  test("a write key also gets the tools that change routines and triggers", async () => {
    const key = await mintKey("u1", "write");
    const response = await post(key, rpcBody("tools/list", {}));
    const rpc = (await readRpc(response)) as {
      result: { tools: { name: string }[] };
    };
    const names = rpc.result.tools.map((tool) => tool.name);
    for (const name of [
      "create_routine",
      "set_routine_enabled",
      "delete_routine",
      "create_trigger",
      "set_trigger_enabled",
      "delete_trigger",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("sends a message with waitMs, gets the echo, and reads the session", async () => {
    const key = await mintKey("u1", "write");
    const agents = await callTool(key, "list_agents", {});
    expect(JSON.stringify(agents.structuredContent)).toContain("agent-a");

    const sent = await callTool(key, "send_message", {
      agent: "agent-a",
      requestId: "req-1",
      text: "ping",
      waitMs: 5000,
    });
    expect(sent.structuredContent).toMatchObject({
      answer: "Echo: ping",
      state: "done",
    });
    const { runId, sessionId } = sent.structuredContent as {
      runId: string;
      sessionId: string;
    };

    const again = await callTool(key, "send_message", {
      agent: "agent-a",
      requestId: "req-1",
      text: "ping",
    });
    expect(again.structuredContent).toMatchObject({ runId });

    const run = await callTool(key, "get_run", { runId });
    expect(run.structuredContent).toMatchObject({ state: "done" });
    const sessionsList = await callTool(key, "list_sessions", {
      agent: "agent-a",
    });
    expect(JSON.stringify(sessionsList.structuredContent)).toContain(sessionId);
    const read = await callTool(key, "read_session", { sessionId });
    expect(JSON.stringify(read.structuredContent)).toContain("Echo: ping");
    const found = await callTool(key, "search_sessions", {
      agent: "agent-a",
      query: "echo",
    });
    expect(JSON.stringify(found.structuredContent)).toContain(sessionId);

    const line = logs.find(
      (entry) => entry.event === "mcp.request" && entry.tool === "send_message"
    );
    expect(line).toMatchObject({ status: 200, via: "api_key" });
    expect(JSON.stringify(logs)).not.toContain(key);
  });

  test("a read-only key cannot send a message", async () => {
    const key = await mintKey("u1", "read");
    const result = await callTool(key, "send_message", {
      agent: "agent-a",
      text: "ping",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "forbidden" });
  });

  test("an unknown agent is a readable error", async () => {
    const key = await mintKey("u1", "write");
    const result = await callTool(key, "list_sessions", { agent: "nobody" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "not_found" });
  });

  test("a user's private ui session run is not_found for another user, and still readable by its opener", async () => {
    addRun({
      agentId: agentA,
      id: "run_ui",
      onBehalfOfUserId: "u1",
      origin: "ui",
    });
    const owner = await mintKey("u1", "read");
    const other = await mintKey("u2", "read");

    const own = await callTool(owner, "get_run", { runId: "run_ui" });
    expect(own.isError).toBeFalsy();
    expect(JSON.stringify(own.structuredContent)).toContain("run_ui");

    const foreign = await callTool(other, "get_run", { runId: "run_ui" });
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent).toMatchObject({ code: "not_found" });
  });
});

describe("tools with a run token", () => {
  test("a run reads its own agent's sessions and gets an empty list for another agent's", async () => {
    const key = await mintKey("u1", "write");
    const sentA = await callTool(key, "send_message", {
      agent: "agent-a",
      text: "about A",
    });
    const sentB = await callTool(key, "send_message", {
      agent: "agent-b",
      text: "about B",
    });
    addRun({ agentId: agentA, id: "run_a", onBehalfOfUserId: "u1" });
    const token = await runToken("run_a", agentA);

    const own = await callTool(token, "list_sessions", { agent: "agent-a" });
    expect(JSON.stringify(own.structuredContent)).toContain(
      (sentA.structuredContent as { sessionId: string }).sessionId
    );
    const read = await callTool(token, "read_session", {
      sessionId: (sentA.structuredContent as { sessionId: string }).sessionId,
    });
    expect(JSON.stringify(read.structuredContent)).toContain("about A");

    const other = await callTool(token, "list_sessions", { agent: "agent-b" });
    expect(other.structuredContent).toMatchObject({ sessions: [] });
    const foreign = await callTool(token, "read_session", {
      sessionId: (sentB.structuredContent as { sessionId: string }).sessionId,
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent).toMatchObject({ code: "not_found" });
  });

  test("a private Slack DM is not_found for a run on behalf of another user, and readable by its own user's run", async () => {
    db.insert(sessions)
      .values({
        actorId: "u2",
        actorKind: "user",
        agentId: agentA,
        createdAt: new Date().toISOString(),
        externalKey: "dm_u2",
        id: "session_dm_u2",
        origin: "slack",
        private: true,
        workspaceId,
      })
      .run();
    addRun({ agentId: agentA, id: "run_u1", onBehalfOfUserId: "u1" });
    addRun({ agentId: agentA, id: "run_u2", onBehalfOfUserId: "u2" });

    const foreign = await callTool(
      await runToken("run_u1", agentA),
      "read_session",
      { sessionId: "session_dm_u2" }
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent).toMatchObject({ code: "not_found" });

    const own = await callTool(
      await runToken("run_u2", agentA),
      "read_session",
      { sessionId: "session_dm_u2" }
    );
    expect(own.isError).toBeFalsy();
  });

  test("send_message from a run on behalf of U creates a run on behalf of U with parent_run_id", async () => {
    addRun({ agentId: agentA, id: "run_a", onBehalfOfUserId: "u2" });
    const token = await runToken("run_a", agentA);

    const sent = await callTool(token, "send_message", {
      agent: "agent-b",
      text: "help",
      waitMs: 1000,
    });
    expect(sent.structuredContent).toMatchObject({
      answer: "Echo: help",
      state: "done",
    });
    const { runId } = sent.structuredContent as { runId: string };
    const [row] = db
      .select()
      .from(runs)
      .all()
      .filter((r) => r.id === runId);
    expect(row).toMatchObject({
      depth: 1,
      onBehalfOfUserId: "u2",
      parentRunId: "run_a",
    });
  });

  test("a message from B back to A while A is B's running ancestor is refused", async () => {
    addRun({ agentId: agentA, id: "run_a", onBehalfOfUserId: "u1" });
    addRun({
      agentId: agentB,
      depth: 1,
      id: "run_b",
      onBehalfOfUserId: "u1",
      parentRunId: "run_a",
    });
    const token = await runToken("run_b", agentB);
    const runCount = db.select().from(runs).all().length;

    const result = await callTool(token, "send_message", {
      agent: "agent-a",
      text: "back to you",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "conflict" });
    expect(db.select().from(runs).all()).toHaveLength(runCount);
  });

  test("a run token whose run is no longer running gets 401", async () => {
    addRun({
      agentId: agentA,
      id: "run_a",
      onBehalfOfUserId: "u1",
      status: "done",
    });
    const token = await runToken("run_a", agentA);
    expect((await post(token, rpcBody("tools/list", {}))).status).toBe(401);
  });
});

describe("the bash tool", () => {
  test("an api key and a run token share the workspace library, and a read-only key cannot write", async () => {
    const writeKey = await mintKey("u1", "write");
    const wrote = await callTool(writeKey, "bash", {
      script: "mkdir -p notes && echo from-key > notes/a.md",
    });
    expect(wrote.structuredContent).toMatchObject({ exitCode: 0 });

    addRun({ agentId: agentA, id: "run_bash", onBehalfOfUserId: "u1" });
    const token = await runToken("run_bash", agentA);
    const found = await callTool(token, "bash", {
      script: "grep -r from-key .",
    });
    expect(found.structuredContent).toMatchObject({
      exitCode: 0,
      stdout: "notes/a.md:from-key\n",
    });

    const readKey = await mintKey("u2", "read");
    const refused = await callTool(readKey, "bash", {
      script: "echo no > notes/b.md",
    });
    expect(refused.structuredContent).toMatchObject({ exitCode: 1 });
    expect(JSON.stringify(refused.structuredContent)).toContain("EACCES");
  });
});

describe("inbox tools", () => {
  test("a write key posts a mention that wakes agent-a, and the thread shows the reply", async () => {
    const key = await mintKey("u1", "write");
    const thread = await composed.services.inbox.createThread(
      sessionUser("u1"),
      {
        title: "Standup",
      }
    );

    const posted = await callTool(key, "inbox_post", {
      text: "@agent-a hi",
      threadId: thread.id,
    });
    expect(posted.isError).toBeFalsy();
    const { runs: woken } = posted.structuredContent as {
      runs: { agentId: string; runId: string }[];
    };
    expect(woken).toHaveLength(1);
    expect(woken[0]?.agentId).toBe(agentA);

    const read = await callTool(key, "inbox_read", { threadId: thread.id });
    expect(read.structuredContent).toMatchObject({
      posts: expect.arrayContaining([
        expect.objectContaining({ authorKind: "user", text: "@agent-a hi" }),
        expect.objectContaining({
          authorKind: "agent",
          runId: woken[0]?.runId,
        }),
      ]),
    });
  });

  test("inbox_list returns the thread", async () => {
    const key = await mintKey("u1", "read");
    const thread = await composed.services.inbox.createThread(
      sessionUser("u1"),
      {
        title: "Standup",
      }
    );
    const listed = await callTool(key, "inbox_list", {});
    expect(listed.structuredContent).toMatchObject({
      threads: [expect.objectContaining({ id: thread.id, title: "Standup" })],
    });
  });

  test("a read-only key can list and read but posting is forbidden", async () => {
    const thread = await composed.services.inbox.createThread(
      sessionUser("u1"),
      {
        title: "Standup",
      }
    );
    const key = await mintKey("u1", "read");

    const read = await callTool(key, "inbox_read", { threadId: thread.id });
    expect(read.isError).toBeFalsy();

    const posted = await callTool(key, "inbox_post", {
      text: "hello",
      threadId: thread.id,
    });
    expect(posted.isError).toBe(true);
    expect(posted.structuredContent).toMatchObject({ code: "forbidden" });
    expect(JSON.stringify(posted)).toContain("forbidden");
  });

  test("a run token posts as its agent, with its run id", async () => {
    const thread = await composed.services.inbox.createThread(
      sessionUser("u1"),
      {
        title: "Standup",
      }
    );
    addRun({ agentId: agentA, id: "run_a", onBehalfOfUserId: "u1" });
    const token = await runToken("run_a", agentA);

    const posted = await callTool(token, "inbox_post", {
      text: "a note",
      threadId: thread.id,
    });
    expect(posted.isError).toBeFalsy();
    expect(posted.structuredContent).toMatchObject({
      post: {
        authorId: agentA,
        authorKind: "agent",
        runId: "run_a",
        text: "a note",
      },
    });
  });

  test("reading an unknown thread is a not_found error", async () => {
    const key = await mintKey("u1", "read");
    const result = await callTool(key, "inbox_read", { threadId: "nope" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "not_found" });
  });
});

describe("Clerk OAuth and the client gate", () => {
  const CLIENT_ID = "client_claude";

  /** A Clerk access token for `userId` through `clientId`, as Clerk would verify it. */
  const oauthToken = (userId: string, clientId = CLIENT_ID): string => {
    const token = `oat_${userId}_${clientId}`;
    oauthTokens.set(token, {
      clientId,
      expiresAt: null,
      scopes: ["profile", "email"],
      userId,
    });
    return token;
  };

  const list = rpcBody("tools/list", {});

  const clients = () => composed.services.oauthClients.list(sessionUser("u1"));

  const body = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>;

  test("a request without a token gets the bare challenge naming the metadata", async () => {
    const response = await post(null, list);
    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(
      'resource_metadata="https://harbourmaster.example.com/.well-known/oauth-protected-resource/mcp"'
    );
    expect(challenge).not.toContain("error=");
  });

  test("a token nobody vouches for gets 401 invalid_token with the metadata", async () => {
    const response = await post("oat_garbage", list);
    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain("resource_metadata=");
  });

  test("a new client is recorded as pending and refused with 403 client_not_approved", async () => {
    const response = await post(oauthToken("u1"), list);
    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    const answer = await body(response);
    expect(answer.error).toBe("client_not_approved");
    expect(String(answer.message)).toContain(CLIENT_ID);
    expect(String(answer.message)).toContain(
      "https://harbourmaster.example.com/settings/connected-apps"
    );
    expect(await clients()).toMatchObject([
      { clientId: CLIENT_ID, name: `App ${CLIENT_ID}`, status: "pending" },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        clientId: CLIENT_ID,
        event: "mcp.denied",
        reason: "pending",
      })
    );
  });

  test("a client already known is not looked up again", async () => {
    const token = oauthToken("u1");
    await post(token, list);
    await post(token, list);
    expect(clientNameCalls).toEqual([CLIENT_ID]);
    expect(await clients()).toHaveLength(1);
  });

  test("once approved, the client lists the tools in the workspace of its approval", async () => {
    const token = oauthToken("u1");
    expect((await post(token, list)).status).toBe(403);
    await composed.services.oauthClients.setAccess(sessionUser("u1"), {
      access: "write",
      clientId: CLIENT_ID,
    });

    const response = await post(token, list);
    expect(response.status).toBe(200);
    const rpc = (await readRpc(response)) as {
      result: { tools: { name: string }[] };
    };
    expect(rpc.result.tools.map((tool) => tool.name)).toContain("send_message");

    const sent = await callTool(token, "send_message", {
      agent: "agent-a",
      text: "ping",
      waitMs: 5000,
    });
    expect(sent.structuredContent).toMatchObject({ answer: "Echo: ping" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        clientId: CLIENT_ID,
        event: "mcp.request",
        userId: "u1",
        via: "oauth",
        workspaceId,
      })
    );
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  test("a read-only approval lists but cannot send a message", async () => {
    const token = oauthToken("u1");
    await post(token, list);
    await composed.services.oauthClients.setAccess(sessionUser("u1"), {
      access: "read",
      clientId: CLIENT_ID,
    });
    expect((await post(token, list)).status).toBe(200);
    const result = await callTool(token, "send_message", {
      agent: "agent-a",
      text: "ping",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "forbidden" });
  });

  test("revoking takes effect on the next request", async () => {
    const token = oauthToken("u1");
    await post(token, list);
    await composed.services.oauthClients.setAccess(sessionUser("u1"), {
      access: "write",
      clientId: CLIENT_ID,
    });
    expect((await post(token, list)).status).toBe(200);

    await composed.services.oauthClients.revoke(sessionUser("u1"), {
      clientId: CLIENT_ID,
    });
    const response = await post(token, list);
    expect(response.status).toBe(403);
    expect(String((await body(response)).message)).toContain("revoked");
  });

  test("a user who left the org gets 401 even though the client is approved", async () => {
    const token = oauthToken("u1");
    await post(token, list);
    await composed.services.oauthClients.setAccess(sessionUser("u1"), {
      access: "write",
      clientId: CLIENT_ID,
    });
    expect((await post(token, list)).status).toBe(200);

    members.delete("u1@org_a");
    expect((await post(token, list)).status).toBe(401);
  });

  test("another user of an approved client needs membership of its workspace", async () => {
    const first = oauthToken("u1");
    await post(first, list);
    await composed.services.oauthClients.setAccess(sessionUser("u1"), {
      access: "write",
      clientId: CLIENT_ID,
    });
    const outsider = oauthToken("u9");
    expect((await post(outsider, list)).status).toBe(401);
    const colleague = oauthToken("u2");
    expect((await post(colleague, list)).status).toBe(200);
  });

  test("a user in none of the allowed orgs gets 403 forbidden and records nothing", async () => {
    const response = await post(oauthToken("u9"), list);
    expect(response.status).toBe(403);
    expect((await body(response)).error).toBe("forbidden");
    expect(await clients()).toEqual([]);
  });

  test("a Clerk outage is 503 with Retry-After, never 401", async () => {
    clerkDown = true;
    const response = await post(oauthToken("u1"), list);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(logs).toContainEqual(
      expect.objectContaining({ misconfigured: false, phase: "authenticate" })
    );
  });

  test("an OAuth client use is recorded in last_used_at", async () => {
    const token = oauthToken("u1");
    await post(token, list);
    await composed.services.oauthClients.setAccess(sessionUser("u1"), {
      access: "read",
      clientId: CLIENT_ID,
    });
    await post(token, list);
    await Promise.all(pendingWork);
    const [client] = await clients();
    expect(client?.lastUsedAt).not.toBeNull();
  });
});
