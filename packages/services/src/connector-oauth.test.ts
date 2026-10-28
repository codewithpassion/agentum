import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  connectors,
  credentials,
  oauthStates,
} from "@repo/db/schema/connectors";
import { events as eventsTable } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type StubMcp, startStubMcp } from "../../../scripts/dev/stub-mcp.ts";
import { type AgentRecord, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import {
  type ConnectorOAuthService,
  createConnectorOAuthService,
  isSameOriginPath,
  OAUTH_STATE_TTL_MS,
} from "./connector-oauth.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import {
  parseOAuthConfig,
  type SharedGoogleClient,
} from "./connectors/oauth-config.ts";
import {
  type ConnectorsService,
  createConnectorsService,
} from "./connectors.ts";
import { decryptSecret, importSecretsKey } from "./crypto.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = new Date("2026-10-16T10:00:00.000Z");
// The guard refuses http and loopback, so the stub is reached as a public
// https host: this fetch carries a request there and tells the stub which
// host it is meant to be, so the metadata it serves names that host.
const PUBLIC_HOST = "mcp.stub-test.com";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const APP_ORIGIN = "https://hm.example.com";
const CALLBACK = `${APP_ORIGIN}/api/connectors/oauth/callback`;
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const APPROVE_LINK = /id="approve" href="([^"]+)"/;
const DENY_LINK = /id="deny" href="([^"]+)"/;
const STUB_AT_PATTERN = /^stub-at-/;
const STUB_RT_PATTERN = /^stub-rt-/;
const ALREADY_USED_PATTERN = /already used/;
const ALREADY_USED_OR_HAS_EXPIRED_PATTERN = /already used or has expired/;
const RETURN_TO_MUST_BE_A_PATH_ON_THIS_SITE_PATTERN =
  /return_to must be a path on this site/;
const NOT_FOUND_I_PATTERN = /not found/i;
const AGENT_NOT_FOUND_PATTERN = /Agent not found/;
const CONNECT_AS_PATTERN = /Connect as/;
const DOES_NOT_USE_OAUTH_PATTERN = /does not use OAuth/;
const EXPIRED_PATTERN = /expired/;
const INVALID_GRANT_PATTERN = /invalid_grant/;
const SET_A_CLIENT_ID_PATTERN = /Set a client id/;
const CONNECTOR_NOT_FOUND_PATTERN = /Connector not found/;
const W_43_PATTERN = /^[\w-]{43}$/;

const principalOf = (userId: string, workspaceId = WORKSPACE): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const dom = principalOf("user_dom");
const sam = principalOf("user_sam");
const outsider = principalOf("user_out", OTHER_WORKSPACE);

let db: ReturnType<typeof migrated>;
let stub: StubMcp;
let now: Date;
let connectorsService: ConnectorsService;
let oauth: ConnectorOAuthService;
let agent: AgentRecord;
let tokenCalls: number;

const clock: Clock = {
  now: () => now,
  sleep: () => Promise.resolve(),
};

const toStub: Fetcher = (input, init) => {
  const raw = typeof input === "string" ? input : String(input);
  if (new URL(raw).pathname === "/oauth/token") {
    tokenCalls += 1;
  }
  const headers = new Headers(init?.headers);
  headers.set("x-forwarded-host", PUBLIC_HOST);
  headers.set("x-forwarded-proto", "https");
  return fetch(raw.replace(PUBLIC_ORIGIN, new URL(stub.url).origin), {
    ...init,
    headers,
  });
};

const seedWorkspace = (id: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START.toISOString(),
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const build = (sharedGoogleClient?: SharedGoogleClient) => {
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
    fetch: toStub,
    secretsKey: SECRETS_KEY,
    sharedGoogleClient,
  };
  connectorsService = createConnectorsService(deps);
  oauth = createConnectorOAuthService(deps);
  return createAgentsService({ db, events });
};

beforeEach(async () => {
  db = migrated();
  now = new Date(START);
  tokenCalls = 0;
  stub = startStubMcp({ oauth: true });
  seedWorkspace(WORKSPACE);
  seedWorkspace(OTHER_WORKSPACE);
  const agents = build();
  agent = await agents.create(dom, {
    model: "claude-sonnet",
    name: "Bruce",
    runtime: "fake",
  });
});

afterEach(() => {
  stub.stop();
});

const addConnector = () =>
  connectorsService.create(dom, {
    name: "Stub",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });

/** What the browser does at the provider: open the page, click Approve or Deny. */
const consent = async (
  authorizeUrl: string,
  button: "approve" | "deny" = "approve"
): Promise<URL> => {
  const page = await (await toStub(authorizeUrl)).text();
  const link = (button === "approve" ? APPROVE_LINK : DENY_LINK).exec(
    page
  )?.[1];
  if (!link) {
    throw new Error("The consent page has no link.");
  }
  return new URL(link.replaceAll("&amp;", "&"));
};

const connect = async (
  principal: Principal,
  connectorId: string,
  as = "user",
  returnTo?: string
) => {
  const { authorizeUrl } = await oauth.start(principal, {
    as,
    connectorId,
    origin: APP_ORIGIN,
    returnTo,
  });
  const back = await consent(authorizeUrl);
  return {
    code: back.searchParams.get("code") ?? "",
    state: back.searchParams.get("state") ?? "",
  };
};

const credentialRows = (connectorId: string) =>
  db
    .select()
    .from(credentials)
    .where(eq(credentials.connectorId, connectorId))
    .all();

test("discovery makes the connector an OAuth connector", async () => {
  const connector = await addConnector();

  expect(connector).toMatchObject({
    authKind: "oauth",
    headerName: null,
    oauth: { canRegister: true, clientConfigured: false },
    status: "needs_auth",
  });
  const [row] = await db.select().from(connectors).all();
  expect(parseOAuthConfig(row?.oauth ?? null)).toMatchObject({
    authorizationEndpoint: `${PUBLIC_ORIGIN}/oauth/authorize`,
    resource: `${PUBLIC_ORIGIN}/mcp`,
    tokenEndpoint: `${PUBLIC_ORIGIN}/oauth/token`,
  });
});

test("connecting as the user and as an agent leaves two credentials with different owners", async () => {
  const connector = await addConnector();

  const asUser = await connect(dom, connector.id, "user");
  const first = await oauth.complete(dom, asUser);
  const asAgent = await connect(dom, connector.id, `agent:${agent.id}`);
  const second = await oauth.complete(dom, asAgent);

  expect(first).toMatchObject({
    error: null,
    returnTo: "/settings/connectors?connected=1",
  });
  expect(second.returnTo).toBe(`/agents/${agent.id}?sheet=tools&connected=1`);
  const rows = credentialRows(connector.id);
  expect(
    rows.map((row) => [row.ownerKind, row.ownerId, row.version]).sort()
  ).toEqual([
    ["agent", agent.id, 1],
    ["user", "user_dom", 1],
  ]);
  const [list] = await connectorsService.list(dom);
  expect(list).toMatchObject({
    myCredential: { ownerKind: "user", status: "ok", version: 1 },
    oauth: { clientConfigured: true },
    status: "ok",
  });
  expect(list?.agentCredentials).toHaveLength(1);
});

test("the stored secret holds both tokens, encrypted for its row, and no response shows them", async () => {
  const connector = await addConnector();
  await oauth.complete(dom, await connect(dom, connector.id));

  const [row] = credentialRows(connector.id);
  expect(row?.secret.startsWith("v1:")).toBe(true);
  expect(row?.secret).not.toContain("stub-at");
  const plain = await decryptSecret(
    await importSecretsKey(SECRETS_KEY),
    {
      field: "secret",
      rowId: row?.id ?? "",
      table: "credentials",
      workspaceId: WORKSPACE,
    },
    row?.secret ?? ""
  );
  expect(JSON.parse(plain)).toEqual({
    accessToken: expect.stringMatching(STUB_AT_PATTERN),
    refreshToken: expect.stringMatching(STUB_RT_PATTERN),
  });
  expect(row?.scopes).toBe("read");
  expect(Date.parse(row?.expiresAt ?? "")).toBe(START.getTime() + 3_600_000);
  const everything = JSON.stringify([
    await connectorsService.list(dom),
    await db.select().from(eventsTable).all(),
  ]);
  expect(everything).not.toContain("stub-at");
  expect(everything).not.toContain("stub-rt");
  expect(everything).not.toContain("stub-client");
});

test("re-authorising replaces the credential and bumps its version", async () => {
  const connector = await addConnector();
  await oauth.complete(dom, await connect(dom, connector.id));
  const [before] = credentialRows(connector.id);

  await oauth.complete(dom, await connect(dom, connector.id));

  const rows = credentialRows(connector.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: before?.id, status: "ok", version: 2 });
  expect(rows[0]?.secret).not.toBe(before?.secret);
});

test("re-authorising brings a needs_auth credential back to ok", async () => {
  const connector = await addConnector();
  await oauth.complete(dom, await connect(dom, connector.id));
  await db
    .update(credentials)
    .set({ refreshingUntil: "2026-10-16T10:00:30.000Z", status: "needs_auth" })
    .run();

  await oauth.complete(dom, await connect(dom, connector.id));

  expect(credentialRows(connector.id)[0]).toMatchObject({
    refreshingUntil: null,
    status: "ok",
    version: 2,
  });
});

test("a callback completed by a different signed-in user is refused and the state row is deleted", async () => {
  const connector = await addConnector();
  const flow = await connect(dom, connector.id);
  expect(await db.select().from(oauthStates).all()).toHaveLength(1);

  await expect(oauth.complete(sam, flow)).rejects.toBeInstanceOf(
    ForbiddenError
  );

  expect(await db.select().from(oauthStates).all()).toHaveLength(0);
  expect(credentialRows(connector.id)).toHaveLength(0);
  expect(tokenCalls).toBe(0);
  // The real initiator cannot use the spent state either.
  await expect(oauth.complete(dom, flow)).rejects.toThrow(ALREADY_USED_PATTERN);
});

test("a state works once", async () => {
  const connector = await addConnector();
  const flow = await connect(dom, connector.id);
  await oauth.complete(dom, flow);

  await expect(oauth.complete(dom, flow)).rejects.toThrow(ALREADY_USED_PATTERN);
  expect(tokenCalls).toBe(1);
});

test("an unknown state is refused", async () => {
  await expect(
    oauth.complete(dom, { code: "c", state: "nope" })
  ).rejects.toThrow(ALREADY_USED_OR_HAS_EXPIRED_PATTERN);
});

test("an off-site return_to is refused and starts nothing", async () => {
  const connector = await addConnector();

  const offSite = [
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
    "connectors",
    "/ok path",
  ];
  await Promise.all(
    offSite.map((returnTo) =>
      expect(
        oauth.start(dom, {
          as: "user",
          connectorId: connector.id,
          origin: APP_ORIGIN,
          returnTo,
        })
      ).rejects.toThrow(RETURN_TO_MUST_BE_A_PATH_ON_THIS_SITE_PATTERN)
    )
  );
  expect(await db.select().from(oauthStates).all()).toHaveLength(0);
});

test("isSameOriginPath accepts app paths with a query and refuses the rest", () => {
  expect(isSameOriginPath("/connectors")).toBe(true);
  expect(isSameOriginPath("/agents/a1?sheet=tools")).toBe(true);
  expect(isSameOriginPath("/")).toBe(true);
  expect(isSameOriginPath("")).toBe(false);
  expect(isSameOriginPath("/%2F/evil")).toBe(true);
  expect(isSameOriginPath("/a\nb")).toBe(false);
  expect(isSameOriginPath("/a b")).toBe(false);
  expect(isSameOriginPath(`/${"a".repeat(2100)}`)).toBe(false);
});

test("connecting as an agent from outside its workspace is refused", async () => {
  const connector = await addConnector();

  await expect(
    oauth.start(outsider, {
      as: `agent:${agent.id}`,
      connectorId: connector.id,
      origin: APP_ORIGIN,
    })
  ).rejects.toThrow(NOT_FOUND_I_PATTERN);
  // A member cannot name an agent that is not in the workspace either.
  await expect(
    oauth.start(dom, {
      as: "agent:agent_nobody",
      connectorId: connector.id,
      origin: APP_ORIGIN,
    })
  ).rejects.toThrow(AGENT_NOT_FOUND_PATTERN);
  expect(await db.select().from(oauthStates).all()).toHaveLength(0);
});

test("a malformed `as` is refused", async () => {
  const connector = await addConnector();

  await Promise.all(
    ["agent:", "someone", "agent"].map((as) =>
      expect(
        oauth.start(dom, { as, connectorId: connector.id, origin: APP_ORIGIN })
      ).rejects.toThrow(CONNECT_AS_PATTERN)
    )
  );
});

test("only a connector that uses OAuth can be connected", async () => {
  const plain = startStubMcp({ token: null });
  try {
    const connector = await createConnectorsService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events: createEventsService({
        blobs: {
          get: () => Promise.resolve(null),
          put: () => Promise.resolve(),
        },
        db,
      }),
      fetch: (input, init) =>
        fetch(
          String(input).replace(PUBLIC_ORIGIN, new URL(plain.url).origin),
          init
        ),
      secretsKey: SECRETS_KEY,
    }).create(dom, { name: "Open", url: `${PUBLIC_ORIGIN}/mcp` });
    expect(connector.authKind).toBe("none");

    await expect(
      oauth.start(dom, {
        as: "user",
        connectorId: connector.id,
        origin: APP_ORIGIN,
      })
    ).rejects.toThrow(DOES_NOT_USE_OAUTH_PATTERN);
  } finally {
    plain.stop();
  }
});

test("a state past its expiry is refused, and the tick purges old states", async () => {
  const connector = await addConnector();
  const stale = await connect(dom, connector.id);
  const fresh = await connect(dom, connector.id);
  now = new Date(START.getTime() + OAUTH_STATE_TTL_MS + 1);
  await db
    .update(oauthStates)
    .set({ expiresAt: new Date(now.getTime() + 1000).toISOString() })
    .where(eq(oauthStates.state, fresh.state))
    .run();

  expect(await oauth.purgeExpired()).toBe(1);
  expect(await db.select().from(oauthStates).all()).toHaveLength(1);
  await expect(oauth.complete(dom, stale)).rejects.toThrow(
    ALREADY_USED_PATTERN
  );

  now = new Date(now.getTime() + 2000);
  const result = await oauth.complete(dom, fresh);
  expect(result.error).toMatch(EXPIRED_PATTERN);
  expect(result.returnTo).toContain("connect_error=");
  expect(credentialRows(connector.id)).toHaveLength(0);
});

test("denying access at the provider sends the person back with the reason", async () => {
  const connector = await addConnector();
  const { authorizeUrl } = await oauth.start(dom, {
    as: "user",
    connectorId: connector.id,
    origin: APP_ORIGIN,
  });
  const back = await consent(authorizeUrl, "deny");

  const result = await oauth.complete(dom, {
    error: back.searchParams.get("error") ?? undefined,
    state: back.searchParams.get("state") ?? "",
  });

  expect(result).toMatchObject({
    connectorId: connector.id,
    error: "access_denied",
  });
  expect(result.returnTo).toBe(
    "/settings/connectors?connect_error=access_denied"
  );
  expect(credentialRows(connector.id)).toHaveLength(0);
  expect(await db.select().from(oauthStates).all()).toHaveLength(0);
});

test("a code the provider refuses sends the person back with its message", async () => {
  const connector = await addConnector();
  const flow = await connect(dom, connector.id);

  const result = await oauth.complete(dom, { ...flow, code: "not-the-code" });

  expect(result.error).toMatch(INVALID_GRANT_PATTERN);
  expect(credentialRows(connector.id)).toHaveLength(0);
});

test("a registered client is reused for the same app origin", async () => {
  const connector = await addConnector();
  await connect(dom, connector.id);
  const [first] = await db.select().from(connectors).all();
  await connect(dom, connector.id, "user");
  const [second] = await db.select().from(connectors).all();

  expect(second?.oauth).toBe(first?.oauth ?? null);
  const config = parseOAuthConfig(second?.oauth ?? null);
  expect(config?.client).toMatchObject({
    redirectUri: CALLBACK,
    source: "registered",
    tokenEndpointAuth: "none",
  });
});

test("a server without registration needs a client typed in first", async () => {
  const connector = await addConnector();
  const [row] = await db.select().from(connectors).all();
  const config = parseOAuthConfig(row?.oauth ?? null);
  await db
    .update(connectors)
    .set({ oauth: JSON.stringify({ ...config, registrationEndpoint: null }) })
    .run();

  await expect(
    oauth.start(dom, {
      as: "user",
      connectorId: connector.id,
      origin: APP_ORIGIN,
    })
  ).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);
  expect(await db.select().from(oauthStates).all()).toHaveLength(0);

  await oauth.setClient(dom, {
    clientId: "typed-client",
    clientSecret: "typed-secret",
    connectorId: connector.id,
  });
  const [typed] = await db.select().from(connectors).all();
  expect(typed?.oauth).not.toContain("typed-secret");
  expect(parseOAuthConfig(typed?.oauth ?? null)?.client).toMatchObject({
    clientId: "typed-client",
    redirectUri: null,
    source: "manual",
    tokenEndpointAuth: "client_secret_basic",
  });
  const [summary] = await connectorsService.list(dom);
  expect(summary?.oauth).toEqual({
    canRegister: false,
    clientConfigured: true,
  });
  const { authorizeUrl } = await oauth.start(dom, {
    as: "user",
    connectorId: connector.id,
    origin: APP_ORIGIN,
  });
  expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(
    "typed-client"
  );
});

test("another workspace cannot set a client or connect", async () => {
  const connector = await addConnector();

  await expect(
    oauth.setClient(outsider, { clientId: "x", connectorId: connector.id })
  ).rejects.toThrow(CONNECTOR_NOT_FOUND_PATTERN);
  await expect(
    oauth.start(outsider, {
      as: "user",
      connectorId: connector.id,
      origin: APP_ORIGIN,
    })
  ).rejects.toThrow(CONNECTOR_NOT_FOUND_PATTERN);
});

test("the authorisation request carries PKCE, the resource and the state", async () => {
  const connector = await addConnector();

  const { authorizeUrl } = await oauth.start(dom, {
    as: "user",
    connectorId: connector.id,
    origin: APP_ORIGIN,
  });

  const params = new URL(authorizeUrl).searchParams;
  expect(params.get("response_type")).toBe("code");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("code_challenge")).toMatch(W_43_PATTERN);
  expect(params.get("redirect_uri")).toBe(CALLBACK);
  expect(params.get("resource")).toBe(`${PUBLIC_ORIGIN}/mcp`);
  const [row] = await db.select().from(oauthStates).all();
  expect(row).toMatchObject({
    initiatorUserId: "user_dom",
    ownerId: "user_dom",
    ownerKind: "user",
    redirectUri: CALLBACK,
    returnTo: "/settings/connectors",
    state: params.get("state"),
    workspaceId: WORKSPACE,
  });
  expect(row?.expiresAt).toBe(
    new Date(START.getTime() + OAUTH_STATE_TTL_MS).toISOString()
  );
});

test("connecting caches the tool list the new token can read", async () => {
  const connector = await addConnector();
  expect(connector.tools).toEqual([]);

  await oauth.complete(dom, await connect(dom, connector.id, "user"));

  const [list] = await connectorsService.list(dom);
  if (!list) {
    throw new Error("the connector is missing");
  }
  expect(list.tools.map((tool) => tool.name)).toEqual(["echo"]);
  expect(list.toolsFetchedAt).not.toBeNull();
});

const SHARED_GOOGLE: SharedGoogleClient = {
  clientId: "shared-id.apps.googleusercontent.com",
  clientSecret: "shared-google-secret",
};
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";

/** A stub connector whose stored discovery says Google, which has no registration. */
const addGoogleConnector = async () => {
  const connector = await addConnector();
  const [row] = await db.select().from(connectors).all();
  const config = parseOAuthConfig(row?.oauth ?? null);
  await db
    .update(connectors)
    .set({
      oauth: JSON.stringify({
        ...config,
        authorizationEndpoint: GOOGLE_AUTHORIZE,
        registrationEndpoint: null,
        tokenEndpoint: "https://oauth2.googleapis.com/token",
      }),
    })
    .run();
  return connector;
};

const startAs = (connectorId: string) =>
  oauth.start(dom, { as: "user", connectorId, origin: APP_ORIGIN });

test("a Google server with the shared client skips the client dialog", async () => {
  build(SHARED_GOOGLE);
  const connector = await addGoogleConnector();

  const [summary] = await connectorsService.list(dom);
  expect(summary?.oauth).toEqual({
    canRegister: true,
    clientConfigured: false,
  });
  const { authorizeUrl } = await startAs(connector.id);
  const url = new URL(authorizeUrl);
  expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE);
  expect(url.searchParams.get("client_id")).toBe(SHARED_GOOGLE.clientId);

  const [row] = await db.select().from(connectors).all();
  expect(row?.oauth).not.toContain(SHARED_GOOGLE.clientSecret);
  const client = parseOAuthConfig(row?.oauth ?? null)?.client;
  expect(client).toMatchObject({
    clientId: SHARED_GOOGLE.clientId,
    source: "shared",
    tokenEndpointAuth: "client_secret_basic",
  });
  const plain = await decryptSecret(
    await importSecretsKey(SECRETS_KEY),
    {
      field: "oauth.clientSecret",
      rowId: connector.id,
      table: "connectors",
      workspaceId: WORKSPACE,
    },
    client?.clientSecret ?? ""
  );
  expect(plain).toBe(SHARED_GOOGLE.clientSecret);
});

test("a client typed on a Google connector wins over the shared one", async () => {
  build(SHARED_GOOGLE);
  const connector = await addGoogleConnector();
  await startAs(connector.id);
  await oauth.setClient(dom, {
    clientId: "typed-client",
    clientSecret: "typed-secret",
    connectorId: connector.id,
  });

  const { authorizeUrl } = await startAs(connector.id);

  expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe(
    "typed-client"
  );
  const [row] = await db.select().from(connectors).all();
  expect(parseOAuthConfig(row?.oauth ?? null)?.client?.source).toBe("manual");
});

test("a Google server without a shared client still needs one typed in", async () => {
  build();
  const connector = await addGoogleConnector();

  const [summary] = await connectorsService.list(dom);
  expect(summary?.oauth).toEqual({
    canRegister: false,
    clientConfigured: false,
  });
  await expect(startAs(connector.id)).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);
});

test("a server that is not Google ignores the shared client", async () => {
  build(SHARED_GOOGLE);
  const connector = await addConnector();
  const [row] = await db.select().from(connectors).all();
  const config = parseOAuthConfig(row?.oauth ?? null);
  await db
    .update(connectors)
    .set({ oauth: JSON.stringify({ ...config, registrationEndpoint: null }) })
    .run();

  await expect(startAs(connector.id)).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);

  await db
    .update(connectors)
    .set({ oauth: JSON.stringify(config) })
    .run();
  const { authorizeUrl } = await startAs(connector.id);
  expect(new URL(authorizeUrl).searchParams.get("client_id")).not.toBe(
    SHARED_GOOGLE.clientId
  );
});

const googleWithTokenEndpoint = async (tokenEndpoint: string) => {
  build(SHARED_GOOGLE);
  const connector = await addGoogleConnector();
  const [row] = await db.select().from(connectors).all();
  const config = parseOAuthConfig(row?.oauth ?? null);
  await db
    .update(connectors)
    .set({ oauth: JSON.stringify({ ...config, tokenEndpoint }) })
    .run();
  return connector.id;
};

test("the shared client is not used when the token endpoint is not Google's", async () => {
  const id = await googleWithTokenEndpoint("https://evil.example/token");
  await expect(startAs(id)).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);
  const [row] = await db.select().from(connectors).all();
  expect(row?.oauth).not.toContain("shared");
});

test("the shared client is not used for a lookalike token host", async () => {
  const id = await googleWithTokenEndpoint(
    "https://oauth2.googleapis.com.evil.example/token"
  );
  await expect(startAs(id)).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);
});

test("a lookalike authorization host does not get the shared client", async () => {
  build(SHARED_GOOGLE);
  const connector = await addGoogleConnector();
  const [row] = await db.select().from(connectors).all();
  const config = parseOAuthConfig(row?.oauth ?? null);
  await db
    .update(connectors)
    .set({
      oauth: JSON.stringify({
        ...config,
        authorizationEndpoint: "https://accounts.google.com.evil.example/auth",
      }),
    })
    .run();
  await expect(startAs(connector.id)).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);
});

test("a stored shared client stops counting once the deployment drops it", async () => {
  build(SHARED_GOOGLE);
  const connector = await addGoogleConnector();
  await startAs(connector.id);
  build();
  const [summary] = await connectorsService.list(dom);
  expect(summary?.oauth).toEqual({
    canRegister: false,
    clientConfigured: false,
  });
  await expect(startAs(connector.id)).rejects.toThrow(SET_A_CLIENT_ID_PATTERN);
});
