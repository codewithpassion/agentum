// The admin tools over `/mcp` (X.10): which key sees which tools, and the
// whole setup flow with an admin key. Secret values and minted keys must not
// reach an event.
import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { connectors } from "@repo/db/schema/connectors";
import { events } from "@repo/db/schema/events";
import { migrated } from "@repo/db/test-db";
import { agentumTools } from "@repo/mcp/server";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "../mcp/ports.ts";
import type { AppEnv } from "./groups.ts";
import { mcpRoutes } from "./mcp.ts";

const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const env = {
  PUBLIC_BASE_URL: "https://agentum.example.com",
  RUN_TOKEN_KEY,
} as unknown as Env;
const MCP_URL = "https://agentum.example.com/mcp";
const HOST = "agentum.example.com";
const SECRET_VALUE = "sk-proxy-0123456789abcdef-VALUE";

const ADMIN_TOOLS = [
  "create_agent",
  "update_agent",
  "create_inbox_thread",
  "create_secret",
  "grant_secret",
  "revoke_secret",
  "create_enrolment_code",
  "create_api_key",
  "revoke_api_key",
  "delete_connector",
];
const WRITE_ADMIN_TOOLS = ADMIN_TOOLS.slice(0, 3);

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceId: string;
let app: Hono<AppEnv>;

const session = (isAdmin: boolean): Principal => ({
  isAdmin,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId,
});

const mintKey = async (access: "admin" | "read" | "write") =>
  composed.services.apiKeys.create(session(true), {
    access,
    name: `${access} key`,
  });

const rpc = async (token: string, method: string, params: unknown) => {
  const response = await app.request(
    MCP_URL,
    {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Host: HOST,
      },
      method: "POST",
    },
    env
  );
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
    : text;
  return { body: JSON.parse(body), status: response.status };
};

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const call = async (
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> =>
  (await rpc(token, "tools/call", { arguments: args, name })).body.result;

const toolNames = async (token: string): Promise<string[]> =>
  (
    (await rpc(token, "tools/list", {})).body.result.tools as { name: string }[]
  ).map((tool) => tool.name);

const allEventText = () => JSON.stringify(db.select().from(events).all());

beforeEach(async () => {
  db = migrated(["org_a"]);
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
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      mailDomain: "agents.example.com",
      members: () =>
        Promise.resolve([
          {
            userId: "u1",
            name: "User",
            email: "u1@example.com",
            imageUrl: null,
            role: "org:member",
          },
        ]),
      relay: noopRelay,
      runTokenKey: RUN_TOKEN_KEY,
      secretsKey: SECRETS_KEY,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a has no workspace row");
  }
  workspaceId = workspace.id;
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    "/mcp",
    mcpRoutes({
      clientName: () => () => Promise.resolve(null),
      defer: () => undefined,
      dev: false,
      isOrgMember: () => () => Promise.resolve(true),
      log: () => undefined,
      userOrgIds: () => () => Promise.resolve(["org_a"]),
      verifyOAuthToken: () => (token) =>
        Promise.resolve(
          token === "oauth-token"
            ? {
                clientId: "client_claude",
                userId: "u1",
                scopes: ["profile"],
                expiresAt: null,
              }
            : null
        ),
    })
  );
});

describe("tool lists", () => {
  test("a read key sees none of the admin tools", async () => {
    const names = await toolNames((await mintKey("read")).secret);
    for (const tool of ADMIN_TOOLS) {
      expect(names).not.toContain(tool);
    }
  });

  test("a write key sees the agent and inbox tools only, and is refused the rest", async () => {
    const { secret } = await mintKey("write");
    const names = await toolNames(secret);
    for (const tool of WRITE_ADMIN_TOOLS) {
      expect(names).toContain(tool);
    }
    for (const tool of ADMIN_TOOLS.slice(3)) {
      expect(names).not.toContain(tool);
    }
    const refused = await rpc(secret, "tools/call", {
      arguments: { mode: "env", name: "TOKEN_A", value: SECRET_VALUE },
      name: "create_secret",
    });
    expect(refused.body.result?.isError ?? true).toBe(true);
    expect(allEventText()).not.toContain(SECRET_VALUE);
  });

  test("an admin key sees every admin tool", async () => {
    const names = await toolNames((await mintKey("admin")).secret);
    for (const tool of ADMIN_TOOLS) {
      expect(names).toContain(tool);
    }
  });
});

describe("audit of calls other paths handle", () => {
  test("assign_skill with a write key writes an admin.action event naming the key", async () => {
    const { key, secret } = await mintKey("write");
    const agent = await call(secret, "create_agent", {
      model: "fake",
      name: "Support",
      runtime: "managed",
    });
    const agentId = (
      agent.structuredContent as unknown as { agent: { id: string } }
    ).agent.id;
    const skill = await call(secret, "create_skill", {
      files: [
        {
          content: "---\nname: shout\ndescription: Shouts.\n---\n\n# shout\n",
          path: "SKILL.md",
        },
      ],
      message: "First version",
      name: "shout",
    });
    expect(skill.isError).toBeFalsy();
    const { skillId } = (
      skill.structuredContent as { version: { skillId: string } }
    ).version;

    const assigned = await call(secret, "assign_skill", {
      agent: agentId,
      skillId,
    });
    expect(assigned.isError).toBeFalsy();

    const audited = db
      .select()
      .from(events)
      .all()
      .filter(
        (row) =>
          row.type === "admin.action" &&
          JSON.parse(row.payload ?? "{}").tool === "assign_skill"
      );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorId: key.id, actorKind: "api_key" });
    expect(JSON.parse(audited[0]?.payload ?? "{}")).toMatchObject({ skillId });
  });
});

describe("a bad secret name", () => {
  test("create_secret says what is wrong with the name", async () => {
    const { secret } = await mintKey("admin");
    const result = await call(secret, "create_secret", {
      mode: "env",
      name: "OPENAI-KEY",
      value: SECRET_VALUE,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("letters, digits and underscores");
  });
});

describe("the setup flow with an admin key", () => {
  test("creates an agent, a granted proxy secret, a thread, a code and a desk key, then revokes the key", async () => {
    const { secret: token } = await mintKey("admin");

    const agent = await call(token, "create_agent", {
      model: "fake",
      name: "Support",
      runtime: "managed",
    });
    expect(agent.isError).toBeFalsy();
    const agentId = (
      agent.structuredContent as unknown as { agent: { id: string } }
    ).agent.id;

    const created = await call(token, "create_secret", {
      mode: "proxy",
      name: "OPENAI_KEY",
      rules: [
        {
          header: "Authorization",
          host: "api.openai.com",
          template: "Bearer {value}",
        },
      ],
      value: SECRET_VALUE,
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.stringify(created)).not.toContain(SECRET_VALUE);
    const secretId = (
      created.structuredContent as unknown as { secret: { id: string } }
    ).secret.id;

    expect(
      (await call(token, "grant_secret", { agent: agentId, secretId })).isError
    ).toBeFalsy();
    expect(
      await composed.services.secrets.grantsOf(session(true), agentId)
    ).toEqual([secretId]);

    const thread = await call(token, "create_inbox_thread", { title: "Setup" });
    expect(thread.isError).toBeFalsy();

    const code = await call(token, "create_enrolment_code", {
      machineName: "box",
    });
    expect(code.isError).toBeFalsy();
    const enrolment = String((code.structuredContent as { code: string }).code);

    const desk = await call(token, "create_api_key", {
      access: "desk",
      name: "desk",
    });
    expect(desk.isError).toBeFalsy();
    const deskKey = (
      desk.structuredContent as { key: { id: string; secret: string } }
    ).key;
    expect(
      (await call(token, "revoke_api_key", { keyId: deskKey.id })).isError
    ).toBeFalsy();

    const text = allEventText();
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(enrolment);
    expect(text).not.toContain(deskKey.secret);
    const audited = db
      .select()
      .from(events)
      .all()
      .filter((row) => row.type === "admin.action");
    expect(audited).toHaveLength(7);
    expect(new Set(audited.map((row) => row.actorKind))).toEqual(
      new Set(["api_key"])
    );
  });

  test("delete_connector writes an admin.action event naming the key", async () => {
    const { secret: token } = await mintKey("admin");
    db.insert(connectors)
      .values({
        authKind: "header",
        createdAt: "2026-10-27T10:00:00.000Z",
        createdBy: "u1",
        id: "conn_1",
        name: "Stub",
        status: "needs_auth",
        url: "https://mcp.example.com/mcp",
        workspaceId,
      })
      .run();
    const deleted = await call(token, "delete_connector", {
      connectorId: "conn_1",
    });
    expect(deleted.isError).toBeFalsy();
    const audited = db
      .select()
      .from(events)
      .all()
      .filter((row) => row.type === "admin.action")
      .map((row) => JSON.parse(row.payload ?? "null"));
    expect(audited).toEqual([
      expect.objectContaining({
        connectorId: "conn_1",
        keyName: "admin key",
        tool: "delete_connector",
      }),
    ]);
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((row) => row.type)
    ).toContain("connector.deleted");
  });
});

const AGENT_MANAGEMENT_TOOLS = [
  "create_agent",
  "update_agent",
  "get_agent",
  "archive_agent",
  "restore_agent",
  "set_agent_owners",
  "set_agent_ask_before",
  "check_agent_address",
  "reserve_agent_address",
];

const approveOAuth = async (access: "read" | "write") => {
  await composed.services.oauthClients.resolve({
    clientId: "client_claude",
    userId: "u1",
    workspaceId,
  });
  await composed.services.oauthClients.setAccess(session(true), {
    clientId: "client_claude",
    access,
  });
};

test("OAuth write manages agents and audits the client and user, without setup access", async () => {
  await approveOAuth("write");
  const token = "oauth-token";
  const names = await toolNames(token);
  for (const name of AGENT_MANAGEMENT_TOOLS) {
    expect(names).toContain(name);
  }
  for (const name of [...ADMIN_TOOLS.slice(2)]) {
    expect(names).not.toContain(name);
    // biome-ignore lint/performance/noAwaitInLoops: Exercise MCP calls in order against one workspace.
    const refused = await rpc(token, "tools/call", { name, arguments: {} });
    expect(refused.body.result?.isError ?? true).toBe(true);
  }
  db.insert(connectors)
    .values({
      id: "c1",
      workspaceId,
      name: "Docs",
      authKind: "header",
      createdAt: new Date().toISOString(),
      createdBy: "u1",
      status: "ok",
      url: "https://docs.example.com/mcp",
    })
    .run();
  const created = await call(token, "create_agent", {
    model: "fake",
    runtime: "managed",
    name: "OAuth agent",
    connectors: ["c1"],
  });
  expect(created.isError).toBeFalsy();
  const agent = "oauth-agent";
  for (const [name, args] of [
    ["update_agent", { agent, instructions: "Help people." }],
    ["check_agent_address", { local: "oauth-agent" }],
    ["reserve_agent_address", { agent, local: "oauth-agent" }],
    ["set_agent_owners", { agent, ownerUserId: "stranger" }],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Exercise MCP calls in order against one workspace.
    const result = await call(token, name, args);
    // The same current-member check as the UI refuses an unknown owner.
    expect(result.isError ?? false).toBe(name === "set_agent_owners");
  }
  await expect(
    composed.services.agents.setOwners(
      session(false),
      (created.structuredContent as { agent: { id: string } }).agent.id,
      { ownerUserId: "stranger", backupUserId: null }
    )
  ).rejects.toThrow();
  expect(
    (
      await call(token, "set_agent_owners", {
        agent,
        ownerUserId: null,
        backupUserId: null,
      })
    ).isError
  ).toBeFalsy();
  expect(
    (
      await call(token, "set_agent_ask_before", {
        agent,
        action: "bash",
        ask: true,
      })
    ).isError
  ).toBeFalsy();
  const detail = await call(token, "get_agent", { agent });
  expect(detail.isError).toBeFalsy();
  expect(detail.structuredContent).toMatchObject({
    agent: {
      instructions: "Help people.",
      emailLocal: "oauth-agent",
      emailAddress: "oauth-agent@agents.example.com",
      ownerUserId: null,
      connectors: [
        expect.objectContaining({ connectorId: "c1", name: "Docs" }),
      ],
      skills: [],
      askBefore: expect.arrayContaining([
        expect.objectContaining({ action: "bash", ask: true }),
      ]),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  });
  expect((await call(token, "archive_agent", { agent })).isError).toBeFalsy();
  expect(
    (await call(token, "get_agent", { agent })).structuredContent
  ).toMatchObject({ agent: { status: "archived" } });
  expect((await call(token, "restore_agent", { agent })).isError).toBeFalsy();
  const audits = db
    .select()
    .from(events)
    .all()
    .filter((row) => row.type === "admin.action");
  expect(audits).toHaveLength(7);
  for (const row of audits) {
    expect(row).toMatchObject({ actorKind: "user", actorId: "u1" });
    expect(JSON.parse(row.payload ?? "{}")).toMatchObject({
      clientId: "client_claude",
      userId: "u1",
    });
    expect(JSON.parse(row.payload ?? "{}")).not.toHaveProperty("keyId");
  }
});

test("OAuth read sees only the agent list and details among management tools", async () => {
  await approveOAuth("read");
  await composed.services.agents.create(session(false), {
    name: "Read me",
    model: "fake",
    runtime: "managed",
  });
  const detail = await call("oauth-token", "get_agent", { agent: "read-me" });
  expect(detail.isError).toBeFalsy();
  expect(detail.structuredContent).toMatchObject({
    agent: { name: "Read me", status: "active" },
  });
  const names = await toolNames("oauth-token");
  expect(names).toContain("list_agents");
  expect(names).toContain("get_agent");
  for (const name of AGENT_MANAGEMENT_TOOLS.filter(
    (tool) => tool !== "get_agent"
  )) {
    expect(names).not.toContain(name);
    // biome-ignore lint/performance/noAwaitInLoops: Exercise MCP calls in order against one workspace.
    const result = await rpc("oauth-token", "tools/call", {
      name,
      arguments: {},
    });
    expect(result.body.result?.isError ?? true).toBe(true);
  }
});

test("run, machine and Slack ports offer none of the agent management writes", () => {
  const principals: Principal[] = [
    { kind: "run", workspaceId, agentId: "a", runId: "r" },
    { kind: "machine", workspaceId, machineId: "m" },
    { kind: "user", via: "slack", userId: "u1", workspaceId },
  ];
  for (const principal of principals) {
    const ports = createMcpPorts({ principal, services: composed.services });
    const names = agentumTools(ports).map((tool) => tool.name);
    for (const name of AGENT_MANAGEMENT_TOOLS.filter(
      (tool) => tool !== "get_agent"
    )) {
      expect(names).not.toContain(name);
    }
  }
});

test("session-bound MCP ports retain the remote tool list without assistant cards or management", async () => {
  const ports = createMcpPorts({
    principal: session(true),
    services: composed.services,
  });
  const names = agentumTools(ports).map((tool) => tool.name);
  expect(names).toContain("send_message");
  for (const name of [...ADMIN_TOOLS, "request_secret", "request_model_key"]) {
    expect(names).not.toContain(name);
  }
  expect((await rpc("", "tools/list", {})).status).toBe(401);
});
