import { beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { connectors, credentials } from "@repo/db/schema/connectors";
import { secrets as secretRows } from "@repo/db/schema/secrets";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createConnectorOAuthService } from "./connector-oauth.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import { callMcpTool } from "./connectors/mcp.ts";
import { parseOAuthConfig } from "./connectors/oauth-config.ts";
import { seedCredential } from "./connectors/test-seed.ts";
import { createConnectorsService } from "./connectors.ts";
import { createCredentialsService } from "./credentials.ts";
import { importSecretsKey } from "./crypto.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { createSecretsService } from "./secrets.ts";
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
let secrets: ReturnType<typeof createSecretsService>;
let credentialService: ReturnType<typeof createCredentialsService>;
let agents: ReturnType<typeof createAgentsService>;
let requested: string[];
let publishesOAuth: boolean;
let requiresAuth: boolean;
let acceptsHeader: boolean;
let echoSecret: boolean;

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
const fakeServer: Fetcher = (input, init) => {
  const url = new URL(typeof input === "string" ? input : String(input));
  requested.push(url.toString());
  if (url.origin === ORIGIN && url.pathname === "/mcp/v1") {
    if (
      requiresAuth &&
      !(
        acceptsHeader &&
        new Headers(init?.headers).get("Authorization") ===
          `Token ${SECRET_VALUE}!`
      )
    ) {
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
          tools: [
            {
              description: echoSecret ? SECRET_VALUE : "d",
              name: "list_things",
            },
          ],
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
  acceptsHeader = false;
  echoSecret = false;
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
  secrets = createSecretsService(deps);
  credentialService = createCredentialsService(deps);
  agents = createAgentsService(deps);
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

const admin: Principal = { ...dom, isAdmin: true };
const SECRET_VALUE = "made-up-key-123456";
const secretForConnector = (allowedHosts = ["mcp.open-server.com"]) =>
  secrets.create(admin, {
    allowedHosts,
    mode: "env",
    name: "CONNECTOR_KEY",
    value: SECRET_VALUE,
  });
const linkedConnector = async () => {
  const secret = await secretForConnector();
  return {
    connector: await service.create(admin, {
      authMode: "header",
      headerTemplate: "Token {value}!",
      name: "Header",
      secretId: secret.id,
      url: MCP_URL,
    }),
    secret,
  };
};

test("API key header forces header even when the server offers OAuth", async () => {
  requiresAuth = true;
  const connector = await service.create(dom, {
    authMode: "header",
    name: "Header",
    url: MCP_URL,
  });
  expect(connector.authKind).toBe("header");
  expect(connector.oauth).toBeNull();
  expect(requested.some((url) => url.includes(".well-known"))).toBe(false);
});

test("linking, replacing and clearing a secret require an admin browser session", async () => {
  const { secret, connector } = await linkedConnector();
  const refused: Principal[] = [
    dom,
    { ...admin, apiKey: { access: "admin", id: "key" }, via: "api_key" },
    {
      ...admin,
      oauthClient: { access: "write", clientId: "client" },
      via: "oauth",
    },
    { agentId: "agent", kind: "run", runId: "run", workspaceId: WORKSPACE },
    { kind: "machine", machineId: "machine", workspaceId: WORKSPACE },
  ];
  for (const principal of refused) {
    // biome-ignore lint/performance/noAwaitInLoops: verify each refused caller independently
    await expect(
      service.create(principal, {
        authMode: "header",
        name: "Denied",
        secretId: secret.id,
        url: MCP_URL,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    for (const secretId of [secret.id, null]) {
      // biome-ignore lint/performance/noAwaitInLoops: verify each refused mutation independently
      await expect(
        service.setAuthMode(principal, {
          authMode: "header",
          connectorId: connector.id,
          secretId,
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(
      service.setAuthMode(principal, {
        authMode: "none",
        connectorId: connector.id,
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect((await service.list(admin))[0]?.secretId).toBe(secret.id);
});

test("a mismatching secret host is refused with Settings guidance, including on an edit", async () => {
  const secret = await secretForConnector(["other.example.com"]);
  const input = {
    authMode: "header" as const,
    name: "Header",
    secretId: secret.id,
    url: MCP_URL,
  };
  await expect(service.create(admin, input)).rejects.toThrow(
    "The host mcp.open-server.com is not allowed by this secret. Add it to the secret in Settings, Secrets."
  );
  const connector = await add();
  await expect(
    service.setAuthMode(admin, {
      authMode: "header",
      connectorId: connector.id,
      secretId: secret.id,
    })
  ).rejects.toThrow("mcp.open-server.com");
});

test("a proxy secret allows its rule hosts using matchHost", async () => {
  const secret = await secrets.create(admin, {
    mode: "proxy",
    name: "PROXY_KEY",
    rules: [
      {
        header: "Authorization",
        host: "*.open-server.com",
        template: "Bearer {value}",
      },
    ],
    value: SECRET_VALUE,
  });
  const connector = await service.create(admin, {
    authMode: "header",
    name: "Header",
    secretId: secret.id,
    url: MCP_URL,
  });
  expect(connector.secretName).toBe("PROXY_KEY");
});

test("the template requires {value} exactly once and has the rule length limit", async () => {
  const secret = await secretForConnector();
  for (const headerTemplate of [
    "Bearer",
    "{value}{value}",
    `${"x".repeat(512)}{value}`,
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: verify each invalid template independently
    await expect(
      service.create(admin, {
        authMode: "header",
        headerTemplate,
        name: "Header",
        secretId: secret.id,
        url: MCP_URL,
      })
    ).rejects.toThrow();
  }
});

test("every caller sends the current templated secret, ignoring pasted credentials and credential mode", async () => {
  const { secret, connector } = await linkedConnector();
  const agent = await agents.create(dom, {
    model: "fake",
    name: "Agent",
    runtime: "fake",
  });
  await seedCredential(db, await importSecretsKey(SECRETS_KEY), {
    connectorId: connector.id,
    now: START,
    ownerId: "user_dom",
    ownerKind: "user",
    secret: "old-pasted-value",
    workspaceId: WORKSPACE,
  });
  const headers: string[] = [];
  const fetchImpl: Fetcher = (_input, init) => {
    headers.push(new Headers(init?.headers).get("Authorization") ?? "");
    return Promise.resolve(
      json({ id: 1, jsonrpc: "2.0", result: { content: [] } })
    );
  };
  for (const credentialMode of ["user", "agent", "user_or_agent"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: each mode must be stored before resolving its callers
    await service.assign(admin, {
      agentId: agent.id,
      connectorId: connector.id,
      credentialMode,
    });
    for (const onBehalfOfUserId of [null, "user_dom", "other-person"]) {
      // biome-ignore lint/performance/noAwaitInLoops: resolution depends on the assignment just written
      const resolved = await credentialService.resolve({
        agentId: agent.id,
        connectorId: connector.id,
        onBehalfOfUserId,
        workspaceId: WORKSPACE,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        throw new Error("Secret did not resolve");
      }
      await callMcpTool(
        connector.url,
        { fetchImpl, header: resolved.credential?.header },
        { arguments: {}, name: "list_things" }
      );
    }
  }
  expect(headers.length).toBeGreaterThan(0);
  expect(headers.every((header) => header === `Token ${SECRET_VALUE}!`)).toBe(
    true
  );
  await secrets.update(admin, secret.id, { value: "replacement-made-up-key" });
  const next = await credentialService.resolveUser({
    connectorId: connector.id,
    userId: "nobody",
    workspaceId: WORKSPACE,
  });
  if (!(next.ok && next.credential)) {
    throw new Error("Secret did not resolve");
  }
  expect(next.credential.ownerKind).toBe("workspace");
  expect(next.ownerKind).toBe("workspace");
  expect(next.credential.header.value).toBe("Token replacement-made-up-key!");
  const serialized = JSON.stringify([
    connector,
    await service.list(admin),
    await service.setCallTimeout(admin, {
      connectorId: connector.id,
      seconds: 60,
    }),
  ]);
  expect(serialized).not.toContain(SECRET_VALUE);
  expect(serialized).not.toContain("replacement-made-up-key");
  expect(serialized).not.toContain("old-pasted-value");
  expect(serialized).not.toContain("valueEnc");
});

test("deleting a secret unlinks the connector and fails clearly without falling back to a pasted credential", async () => {
  const { secret, connector } = await linkedConnector();
  await seedCredential(db, await importSecretsKey(SECRETS_KEY), {
    connectorId: connector.id,
    now: START,
    ownerId: "user_dom",
    ownerKind: "user",
    secret: "old-pasted-value",
    workspaceId: WORKSPACE,
  });
  await secrets.remove(admin, secret.id);
  const [row] = await service.list(admin);
  expect(row?.secretId).toBeNull();
  expect(row?.status).toBe("needs_auth");
  expect(row?.headerTemplate).toBe("Token {value}!");
  await expect(
    credentialService.resolveUser({
      connectorId: connector.id,
      userId: "user_dom",
      workspaceId: WORKSPACE,
    })
  ).rejects.toThrow("The connector's secret was removed");
});

test("changing authentication away from header clears both the link and template", async () => {
  const { connector } = await linkedConnector();
  const changed = await service.setAuthMode(admin, {
    authMode: "none",
    connectorId: connector.id,
  });
  expect(changed.secretId).toBeNull();
  expect(changed.headerTemplate).toBeNull();
  expect(changed.secretName).toBeNull();
});

test("removing an allowed host blocks the next call", async () => {
  const { secret, connector } = await linkedConnector();
  await secrets.update(admin, secret.id, { allowedHosts: [] });
  await expect(
    credentialService.resolveUser({
      connectorId: connector.id,
      userId: "user_dom",
      workspaceId: WORKSPACE,
    })
  ).rejects.toThrow("Settings, Secrets");
});

test("linking probes with the secret and never returns a value echoed in tool metadata", async () => {
  requiresAuth = true;
  acceptsHeader = true;
  echoSecret = true;
  const { connector } = await linkedConnector();
  expect(connector.status).toBe("ok");
  expect(connector.tools).toHaveLength(1);
  expect(connector.tools[0]?.description).toBe("[secret:connector]");
  expect(JSON.stringify([connector, await service.list(admin)])).not.toContain(
    SECRET_VALUE
  );
});

test("deletion also marks a linked connector whose template was null as needing a secret", async () => {
  const { secret, connector } = await linkedConnector();
  await db
    .update(connectors)
    .set({ headerTemplate: null })
    .where(eq(connectors.id, connector.id));
  await secrets.remove(admin, secret.id);
  expect((await service.list(admin))[0]?.headerTemplate).toBe("Bearer {value}");
  await expect(
    credentialService.resolveUser({
      connectorId: connector.id,
      userId: "user_dom",
      workspaceId: WORKSPACE,
    })
  ).rejects.toThrow("The connector's secret was removed");
});

test("assigning a secret connector and editing its assignment need an admin in the app", async () => {
  const { connector } = await linkedConnector();
  const agent = await agents.create(dom, {
    model: "fake",
    name: "Agent",
    runtime: "fake",
  });
  const input = {
    agentId: agent.id,
    connectorId: connector.id,
    credentialMode: "agent" as const,
  };
  for (const principal of [
    dom,
    {
      ...admin,
      apiKey: { access: "admin" as const, id: "key" },
      via: "api_key" as const,
    },
    {
      ...admin,
      oauthClient: { access: "write" as const, clientId: "client" },
      via: "oauth" as const,
    },
    {
      agentId: agent.id,
      kind: "run" as const,
      runId: "run",
      workspaceId: WORKSPACE,
    },
    { kind: "machine" as const, machineId: "machine", workspaceId: WORKSPACE },
    {
      agentId: agent.id,
      connectionId: "peer",
      kind: "peer" as const,
      workspaceId: WORKSPACE,
    },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: verify each caller against the same assignment
    await expect(service.assign(principal, input)).rejects.toThrow(
      "An admin must do this in the app."
    );
  }
  await service.assign(admin, input);
  await expect(
    service.assign(dom, { ...input, allowedTools: [] })
  ).rejects.toThrow("An admin must do this in the app.");
  await expect(
    service.assign(dom, { ...input, credentialMode: "user" })
  ).rejects.toThrow("An admin must do this in the app.");
  expect(
    await service.unassign(dom, {
      agentId: agent.id,
      connectorId: connector.id,
    })
  ).toEqual({ removed: true });
});

test("unknown and cross-workspace secrets say not found at link time", async () => {
  const secret = await secretForConnector();
  for (const secretId of ["unknown", secret.id]) {
    // biome-ignore lint/performance/noAwaitInLoops: verify missing and foreign ids independently
    await expect(
      service.create(
        { ...admin, workspaceId: secretId === secret.id ? "w2" : WORKSPACE },
        { authMode: "header", name: "Header", secretId, url: MCP_URL }
      )
    ).rejects.toThrow("Secret not found.");
  }
});

test("listing linked connectors loads all secret names in one query", async () => {
  const { secret } = await linkedConnector();
  await service.create(admin, {
    authMode: "header",
    name: "Second",
    secretId: secret.id,
    url: MCP_URL,
  });
  const select = spyOn(db, "select");
  try {
    const listed = await service.list(admin);
    expect(listed.map((row) => row.secretName)).toEqual([
      "CONNECTOR_KEY",
      "CONNECTOR_KEY",
    ]);
    expect(
      select.mock.calls.filter(([fields]) => fields?.name === secretRows.name)
    ).toHaveLength(1);
  } finally {
    select.mockRestore();
  }
});
