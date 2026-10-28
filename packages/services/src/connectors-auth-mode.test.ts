import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { connectors, credentials } from "@repo/db/schema/connectors";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createConnectorOAuthService } from "./connector-oauth.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import { parseOAuthConfig } from "./connectors/oauth-config.ts";
import { createConnectorsService } from "./connectors.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-28T10:00:00.000Z";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const ORIGIN = "https://mcp.open-server.com";
const MCP_URL = `${ORIGIN}/mcp/v1`;
const AS_ORIGIN = "https://accounts.auth-server.com";
const APP_ORIGIN = "https://hm.example.com";
const NOT_PUBLISH_PATTERN = /does not publish OAuth metadata/;
const NO_REGISTER_PATTERN = /does not register clients/;

const dom: Principal = {
  kind: "user",
  userId: "user_dom",
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createConnectorsService>;
let oauth: ReturnType<typeof createConnectorOAuthService>;
let requested: string[];
let publishesOAuth: boolean;
let requiresAuth: boolean;

const clock: Clock = {
  now: () => new Date(START),
  sleep: () => Promise.resolve(),
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/**
 * A server shaped like gmailmcp.googleapis.com: it publishes OAuth metadata
 * (path-aware, no registration endpoint) and by default answers MCP calls
 * without a token.
 */
const fakeServer: Fetcher = (input) => {
  const url = new URL(typeof input === "string" ? input : String(input));
  requested.push(url.toString());
  if (url.origin === ORIGIN && url.pathname === "/mcp/v1") {
    if (requiresAuth) {
      return Promise.resolve(
        new Response(null, {
          headers: { "www-authenticate": 'Bearer realm="x"' },
          status: 401,
        })
      );
    }
    return Promise.resolve(
      json({
        id: 1,
        jsonrpc: "2.0",
        result: {
          serverInfo: { name: "open" },
          tools: [{ description: "d", name: "list_things" }],
        },
      })
    );
  }
  if (
    publishesOAuth &&
    url.origin === ORIGIN &&
    url.pathname === "/.well-known/oauth-protected-resource/mcp/v1"
  ) {
    return Promise.resolve(
      json({
        authorization_servers: [`${AS_ORIGIN}/`],
        resource: MCP_URL,
        scopes_supported: ["scope.a", "scope.b"],
      })
    );
  }
  if (
    publishesOAuth &&
    url.origin === AS_ORIGIN &&
    url.pathname === "/.well-known/oauth-authorization-server"
  ) {
    return Promise.resolve(
      json({
        authorization_endpoint: `${AS_ORIGIN}/auth`,
        issuer: AS_ORIGIN,
        token_endpoint: `${AS_ORIGIN}/token`,
      })
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
};

beforeEach(() => {
  db = migrated();
  requested = [];
  publishesOAuth = true;
  requiresAuth = false;
  db.insert(workspaces)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  const store = new Map<string, string>();
  const events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  const deps = {
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetch: fakeServer,
    secretsKey: SECRETS_KEY,
  };
  service = createConnectorsService(deps);
  oauth = createConnectorOAuthService(deps);
});

const add = (authMode?: "auto" | "oauth" | "none") =>
  service.create(dom, { authMode, name: "Open", url: MCP_URL });

test("automatic on a server that answers without a 401 saves it as needing no auth, and never runs discovery", async () => {
  const connector = await add();
  expect(connector.authMode).toBe("auto");
  expect(connector.authKind).toBe("none");
  expect(connector.status).toBe("ok");
  expect(requested.some((url) => url.includes(".well-known"))).toBe(false);
});

test("forced OAuth runs the ladder on a server that answers 200, and a client can be typed in", async () => {
  const connector = await add("oauth");
  expect(connector.authMode).toBe("oauth");
  expect(connector.authKind).toBe("oauth");
  expect(connector.status).toBe("needs_auth");
  // Tools the open server listed are kept for the picker.
  expect(connector.tools.map((tool) => tool.name)).toEqual(["list_things"]);
  expect(connector.oauth).toEqual({
    canRegister: false,
    clientConfigured: false,
  });

  // No registration endpoint: Connect needs the manual client first.
  await expect(
    oauth.start(dom, {
      as: "user",
      connectorId: connector.id,
      origin: APP_ORIGIN,
    })
  ).rejects.toThrow(NO_REGISTER_PATTERN);

  await oauth.setClient(dom, {
    clientId: "cid",
    clientSecret: "csecret",
    connectorId: connector.id,
  });
  const { authorizeUrl } = await oauth.start(dom, {
    as: "user",
    connectorId: connector.id,
    origin: APP_ORIGIN,
  });
  const authorize = new URL(authorizeUrl);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${AS_ORIGIN}/auth`);
  expect(authorize.searchParams.get("client_id")).toBe("cid");
  expect(authorize.searchParams.get("resource")).toBe(MCP_URL);
  expect(authorize.searchParams.get("scope")).toBe("scope.a scope.b");
});

test("forced OAuth is refused when the server publishes no OAuth metadata", async () => {
  publishesOAuth = false;
  await expect(add("oauth")).rejects.toThrow(NOT_PUBLISH_PATTERN);
  expect(db.select().from(connectors).all()).toHaveLength(0);
});

test("forced none never starts OAuth, even when the server asks for auth and has metadata", async () => {
  requiresAuth = true;
  const connector = await add("none");
  expect(connector.authMode).toBe("none");
  expect(connector.authKind).toBe("none");
  expect(connector.oauth).toBeNull();
  expect(requested.some((url) => url.includes(".well-known"))).toBe(false);
});

test("automatic on a server that answers 401 still finds OAuth", async () => {
  requiresAuth = true;
  const connector = await add();
  expect(connector.authMode).toBe("auto");
  expect(connector.authKind).toBe("oauth");
});

test("the choice persists, and a probe with the same answer leaves it", async () => {
  const connector = await add("oauth");
  await oauth.setClient(dom, {
    clientId: "cid",
    connectorId: connector.id,
  });
  const again = await service.setAuthMode(dom, {
    authMode: "oauth",
    connectorId: connector.id,
  });
  expect(again.authMode).toBe("oauth");
  expect(again.authKind).toBe("oauth");
  // The typed client survives, because the kind did not change.
  expect(again.oauth?.clientConfigured).toBe(true);
  const [row] = db.select().from(connectors).all();
  expect(row?.authMode).toBe("oauth");
  expect(parseOAuthConfig(row?.oauth ?? null)?.client?.clientId).toBe("cid");
  const listed = await service.list(dom);
  expect(listed[0]?.authMode).toBe("oauth");
});

test("switching an existing connector to OAuth and back to none", async () => {
  const connector = await add();
  expect(connector.authKind).toBe("none");

  const forced = await service.setAuthMode(dom, {
    authMode: "oauth",
    connectorId: connector.id,
  });
  expect(forced.authKind).toBe("oauth");
  expect(forced.status).toBe("needs_auth");

  const off = await service.setAuthMode(dom, {
    authMode: "none",
    connectorId: connector.id,
  });
  expect(off.authKind).toBe("none");
  expect(off.status).toBe("ok");
  expect(off.oauth).toBeNull();
});

test("changing the kind drops the logins the old kind stored", async () => {
  const connector = await add("oauth");
  await db.insert(credentials).values({
    connectorId: connector.id,
    createdAt: START,
    createdBy: "user_dom",
    id: "cred1",
    ownerId: "user_dom",
    ownerKind: "user",
    secret: "ciphertext",
    updatedAt: START,
    workspaceId: WORKSPACE,
  });
  await service.setAuthMode(dom, {
    authMode: "none",
    connectorId: connector.id,
  });
  expect(
    db
      .select()
      .from(credentials)
      .where(eq(credentials.connectorId, connector.id))
      .all()
  ).toHaveLength(0);
});

test("setting the mode needs a session in the connector's workspace", async () => {
  const connector = await add();
  await expect(
    service.setAuthMode(
      { ...dom, workspaceId: "w2" },
      { authMode: "none", connectorId: connector.id }
    )
  ).rejects.toThrow();
});
