// The admin tools over `/mcp` (X.10): which key sees which tools, and the
// whole setup flow with an admin key. Secret values and minted keys must not
// reach an event.
import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { mcpRoutes } from "./mcp.ts";

const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const env = {
  ALLOWED_ORG_IDS: "org_a",
  PUBLIC_BASE_URL: "https://harbourmaster.example.com",
  RUN_TOKEN_KEY,
} as unknown as Env;
const MCP_URL = "https://harbourmaster.example.com/mcp";
const HOST = "harbourmaster.example.com";
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
      secretsKey: SECRETS_KEY,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a is not an allowed organisation");
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
      verifyOAuthToken: () => () => Promise.resolve(null),
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
});
