import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { decryptSecret, generateConnectorKey } from "#/crypto";
import type { Db } from "#/db/client";
import {
  clearConnectorResyncPending,
  createAgent,
  getAgentById,
} from "#/modules/agents/service";
import type { VaultGateway } from "#/modules/anthropic/vaults";
import {
  createWorkspace,
  DEFAULT_WORKSPACE_ID,
} from "#/modules/workspaces/service";
import { connectorOauthFlows, connectors } from "./schema";
import {
  addConnector,
  assignConnector,
  beginReauthorization,
  ConnectorCapError,
  type ConnectorContext,
  ConnectorFlowError,
  completeBearer,
  completeOAuthCallback,
  getConnector,
  listAgentIdsForConnector,
  listConnectorsForAgent,
  recordConnectorAuthFailure,
  removeConnector,
  renameConnector,
  setConnectorDisabled,
  testConnection,
  unassignConnector,
  validateFlow,
} from "./service";
import { connectorServerName, MAX_AGENT_CONNECTORS } from "./usability";

/**
 * A real database - the module's own migrations, applied to an in-memory
 * SQLite - with the MCP server, the authorization server and the Anthropic
 * vaults faked. That combination is what lets the callback, bearer and remove
 * paths be tested end to end without a Worker.
 */

const MCP_URL = "https://mcp.example.com/mcp";
const REDIRECT_URI = "https://app.example.com/api/connectors/oauth/callback";
const KEY = generateConnectorKey();
const HOUR_MS = 3_600_000;

const UNIQUE_CONSTRAINT = /UNIQUE constraint/;
const BLOCKED_ADDRESS = /loopback|private/;
const NO_OAUTH_METADATA = /does not publish OAuth metadata/;
const STATE_MISMATCH = /did not match/;
const STATE_EXPIRED = /took too long/;
const REFUSED_GRANT = /invalid_grant/;
const MANAGEMENT_REAUTH = /Re-authorize for management features/;

/**
 * The module's own migrations, applied in journal order to a fresh in-memory
 * database - so these tests run against the schema that actually ships, and
 * would notice a migration that stopped applying.
 */
const migrate = (): Db => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return drizzle(sqlite) as unknown as Db;
};

// --- fakes ------------------------------------------------------------------

interface VaultCalls {
  bearerCredentials: { token: string; vaultId: string }[];
  deleted: string[];
  oauthCredentials: {
    refresh: unknown;
    vaultId: string;
  }[];
  updates: { credentialId: string; refreshToken: string | null }[];
  vaults: string[];
}

const fakeVaults = (): { calls: VaultCalls; gateway: VaultGateway } => {
  const calls: VaultCalls = {
    bearerCredentials: [],
    deleted: [],
    oauthCredentials: [],
    updates: [],
    vaults: [],
  };

  const gateway: VaultGateway = {
    createBearerCredential(input) {
      calls.bearerCredentials.push({
        token: input.token,
        vaultId: input.vaultId,
      });
      return Promise.resolve("cred_bearer");
    },
    createOAuthCredential(input) {
      calls.oauthCredentials.push({
        refresh: input.refresh,
        vaultId: input.vaultId,
      });
      return Promise.resolve("cred_oauth");
    },
    createVault(input) {
      const id = `vault_${calls.vaults.length + 1}`;
      calls.vaults.push(input.connectorId);
      return Promise.resolve(id);
    },
    deleteVault(vaultId) {
      calls.deleted.push(vaultId);
      return Promise.resolve();
    },
    updateOAuthSecrets(input) {
      calls.updates.push({
        credentialId: input.credentialId,
        refreshToken: input.refreshToken,
      });
      return Promise.resolve();
    },
  };
  return { calls, gateway };
};

type Handler = (url: string, init: RequestInit | undefined) => Response | null;

/** A world made of ordered handlers; the first that answers wins. */
const world = (handlers: Handler[]): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const handler of handlers) {
      const response = handler(url, init);
      if (response) {
        return Promise.resolve(response);
      }
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof fetch;

const AS_METADATA = {
  authorization_endpoint: "https://auth.example.com/authorize",
  issuer: "https://auth.example.com",
  registration_endpoint: "https://auth.example.com/register",
  token_endpoint: "https://auth.example.com/token",
};

const metadataHandler =
  (metadata: Record<string, unknown> = AS_METADATA): Handler =>
  (url) => {
    if (url.includes("oauth-protected-resource")) {
      return Response.json({
        authorization_servers: ["https://auth.example.com"],
      });
    }
    if (url.includes("oauth-authorization-server")) {
      return Response.json(metadata);
    }
    return null;
  };

const registrationHandler = (): Handler => (url) =>
  url === "https://auth.example.com/register"
    ? Response.json({ client_id: "cid_registered" })
    : null;

const tokenHandler =
  (payload: Record<string, unknown>, status = 200): Handler =>
  (url) =>
    url === "https://auth.example.com/token"
      ? Response.json(payload, { status })
      : null;

/** An MCP endpoint that answers only when the expected token is presented. */
const mcpHandler =
  (expectedToken: string | null, tools = ["create_issue"]): Handler =>
  (url, init) => {
    if (url !== MCP_URL) {
      return null;
    }
    const presented =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ??
      null;
    if (presented !== expectedToken) {
      return new Response("", {
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"`,
        },
        status: 401,
      });
    }
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    if (method === "initialize") {
      return Response.json({
        id: 1,
        result: { serverInfo: { name: "example" } },
      });
    }
    if (method === "tools/list") {
      return Response.json({
        id: 1,
        result: { tools: tools.map((name) => ({ name })) },
      });
    }
    return new Response(null, { status: 202 });
  };

// --- fixtures ---------------------------------------------------------------

let db: Db;
let vaults: ReturnType<typeof fakeVaults>;

beforeEach(() => {
  db = migrate();
  vaults = fakeVaults();
});

const contextWith = (fetchImpl: typeof fetch): ConnectorContext => ({
  db,
  fetchImpl,
  key: KEY,
  redirectUri: REDIRECT_URI,
  vaults: vaults.gateway,
});

/** Fails loudly rather than asserting through a non-null assertion. */
const must = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${what}.`);
  }
  return value;
};

const flowFor = async (connectorId: string) => {
  const [flow] = await db
    .select()
    .from(connectorOauthFlows)
    .where(eq(connectorOauthFlows.connectorId, connectorId));
  return flow;
};

/** Drives the ladder up to a stored flow and hands back the state to call back with. */
const authorized = async (
  ctx: ConnectorContext
): Promise<{ connectorId: string; state: string }> => {
  const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
    url: MCP_URL,
  });
  const flow = await flowFor(connector.id);
  if (!flow) {
    throw new Error("Expected a stored OAuth flow.");
  }
  return { connectorId: connector.id, state: flow.state };
};

// --- rung 1 -----------------------------------------------------------------

describe("addConnector", () => {
  test("a server that needs no auth is connected with its tools, and no vault", async () => {
    const ctx = contextWith(world([mcpHandler(null, ["a", "b"])]));
    const { connector, outcome } = await addConnector(
      ctx,
      DEFAULT_WORKSPACE_ID,
      {
        name: "Docs",
        url: MCP_URL,
      }
    );

    expect(outcome).toEqual({ kind: "connected" });
    expect(connector.status).toBe("connected");
    expect(connector.authKind).toBe("none");
    expect(connector.toolCache?.tools.map((tool) => tool.name)).toEqual([
      "a",
      "b",
    ]);
    expect(vaults.calls.vaults).toEqual([]);
  });

  test("names the connector after its host when none is given", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    expect(connector.name).toBe("mcp.example.com");
  });

  test("stores the canonical URL, so two spellings collide", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: "https://MCP.example.com/mcp#frag",
    });
    expect(
      addConnector(ctx, DEFAULT_WORKSPACE_ID, { url: MCP_URL })
    ).rejects.toThrow(UNIQUE_CONSTRAINT);
  });

  test("refuses a private address before probing it", () => {
    const ctx = contextWith(world([]));
    expect(
      addConnector(ctx, DEFAULT_WORKSPACE_ID, { url: "https://127.0.0.1/mcp" })
    ).rejects.toThrow(BLOCKED_ADDRESS);
  });

  // --- rungs 2 and 3 --------------------------------------------------------

  test("a 401 walks discovery, registers a client and returns an authorize URL", async () => {
    const ctx = contextWith(
      world([mcpHandler("at_1"), metadataHandler(), registrationHandler()])
    );
    const { connector, outcome } = await addConnector(
      ctx,
      DEFAULT_WORKSPACE_ID,
      { url: MCP_URL }
    );

    expect(outcome.kind).toBe("authorize");
    const authorizeUrl = new URL(
      (outcome as { authorizeUrl: string }).authorizeUrl
    );
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://auth.example.com/authorize"
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("cid_registered");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("resource")).toBe(MCP_URL);

    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(stored?.status).toBe("authorizing");
    expect(stored?.authKind).toBe("oauth");
    expect(stored?.oauthClientId).toBe("cid_registered");
    expect(stored?.oauthTokenEndpoint).toBe("https://auth.example.com/token");

    const flow = await flowFor(connector.id);
    expect(authorizeUrl.searchParams.get("state")).toBe(flow?.state ?? "");
    expect(flow?.redirectUri).toBe(REDIRECT_URI);
  });

  test("asks for a client id when the server has no dynamic registration", async () => {
    const { registration_endpoint, ...noDcr } = AS_METADATA;
    const ctx = contextWith(
      world([mcpHandler("at_1"), metadataHandler(noDcr)])
    );
    const { connector, outcome } = await addConnector(
      ctx,
      DEFAULT_WORKSPACE_ID,
      { url: MCP_URL }
    );

    expect(outcome).toEqual({
      issuer: "https://auth.example.com",
      kind: "needs_client",
    });
    // The token endpoint is remembered so the manual path can finish.
    expect(
      (await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id))
        ?.oauthTokenEndpoint
    ).toBe("https://auth.example.com/token");
    expect(await flowFor(connector.id)).toBeUndefined();
  });

  test("a supplied client id resumes the ladder", async () => {
    const { registration_endpoint, ...noDcr } = AS_METADATA;
    const ctx = contextWith(
      world([mcpHandler("at_1"), metadataHandler(noDcr)])
    );
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    const outcome = await beginReauthorization(ctx, connector, {
      clientId: "cid_manual",
      clientSecret: "sec_manual",
    });

    expect(outcome.kind).toBe("authorize");
    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(stored?.oauthClientId).toBe("cid_manual");
    // A confidential client, and the secret never lands in plaintext.
    expect(stored?.oauthTokenEndpointAuth).toBe("client_secret_basic");
    expect(stored?.oauthClientSecretEnc).not.toContain("sec_manual");
    expect(await decryptSecret(KEY, stored?.oauthClientSecretEnc ?? "")).toBe(
      "sec_manual"
    );
  });

  test("offers the bearer fallback when the server publishes no OAuth metadata", async () => {
    const ctx = contextWith(world([mcpHandler("at_1")]));
    const { connector, outcome } = await addConnector(
      ctx,
      DEFAULT_WORKSPACE_ID,
      { url: MCP_URL }
    );

    expect(outcome.kind).toBe("needs_bearer");
    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(stored?.status).toBe("unconfigured");
    expect(stored?.lastError).toMatch(NO_OAUTH_METADATA);
  });

  test("keeps an unreachable server in the directory with its error", async () => {
    const ctx = contextWith(
      world([
        (url) =>
          url === MCP_URL ? new Response("nope", { status: 502 }) : null,
      ])
    );
    const { connector, outcome } = await addConnector(
      ctx,
      DEFAULT_WORKSPACE_ID,
      { url: MCP_URL }
    );

    expect(outcome.kind).toBe("needs_bearer");
    expect(
      (await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id))?.lastError
    ).toContain("502");
  });
});

// --- rungs 4 and 5: the callback --------------------------------------------

describe("validateFlow", () => {
  const flow = {
    connectorId: "c1",
    createdAt: new Date(),
    expiresAt: new Date(2000),
    redirectUri: REDIRECT_URI,
    scope: null,
    state: "good",
    verifier: "v",
    workspaceId: DEFAULT_WORKSPACE_ID,
  };

  test("accepts a matching, unexpired flow", () => {
    expect(validateFlow(flow, "good", new Date(1000)).state).toBe("good");
  });

  test("rejects an unknown state", () => {
    expect(() => validateFlow(undefined, "good", new Date(1000))).toThrow(
      ConnectorFlowError
    );
  });

  test("rejects a mismatched state", () => {
    expect(() => validateFlow(flow, "forged", new Date(1000))).toThrow(
      STATE_MISMATCH
    );
  });

  test("rejects an expired flow", () => {
    expect(() => validateFlow(flow, "good", new Date(9000))).toThrow(
      STATE_EXPIRED
    );
  });
});

describe("completeOAuthCallback", () => {
  const withGrant = (grant: Record<string, unknown>) =>
    world([
      mcpHandler("at_1"),
      metadataHandler(),
      registrationHandler(),
      tokenHandler(grant),
    ]);

  test("exchanges the code, encrypts the copy and vaults the credential", async () => {
    const ctx = contextWith(
      withGrant({
        access_token: "at_1",
        expires_in: 3600,
        refresh_token: "rt_1",
      })
    );
    const { connectorId, state } = await authorized(ctx);

    const connector = await completeOAuthCallback(ctx, {
      code: "code_1",
      state,
    });

    expect(connector.status).toBe("connected");
    expect(connector.authKind).toBe("oauth");
    expect(connector.vaultId).toBe("vault_1");
    expect(connector.vaultCredentialId).toBe("cred_oauth");
    expect(connector.mgmtError).toBeNull();

    // Encrypted at rest, and recoverable.
    expect(connector.mgmtAccessTokenEnc).not.toContain("at_1");
    expect(await decryptSecret(KEY, connector.mgmtAccessTokenEnc ?? "")).toBe(
      "at_1"
    );
    expect(await decryptSecret(KEY, connector.mgmtRefreshTokenEnc ?? "")).toBe(
      "rt_1"
    );

    // A refresh token was granted, so Anthropic gets the block that lets it
    // keep the credential alive on its own.
    expect(vaults.calls.oauthCredentials).toHaveLength(1);
    expect(vaults.calls.oauthCredentials[0]?.refresh).toMatchObject({
      clientId: "cid_registered",
      refreshToken: "rt_1",
      tokenEndpoint: "https://auth.example.com/token",
      tokenEndpointAuth: "none",
    });

    // The tools were listed with the new token.
    expect(connector.toolCache?.tools.map((tool) => tool.name)).toEqual([
      "create_issue",
    ]);
    expect(await flowFor(connectorId)).toBeUndefined();
  });

  test("omits the refresh block when the grant carried no refresh token", async () => {
    const ctx = contextWith(
      withGrant({ access_token: "at_1", expires_in: 60 })
    );
    const { state } = await authorized(ctx);

    const connector = await completeOAuthCallback(ctx, { code: "c", state });

    expect(connector.mgmtRefreshTokenEnc).toBeNull();
    expect(vaults.calls.oauthCredentials[0]?.refresh).toBeNull();
  });

  test("rejects a forged state without touching the token endpoint", async () => {
    const ctx = contextWith(
      withGrant({ access_token: "at_1", refresh_token: "rt_1" })
    );
    await authorized(ctx);

    expect(
      completeOAuthCallback(ctx, { code: "c", state: "forged" })
    ).rejects.toBeInstanceOf(ConnectorFlowError);
    expect(vaults.calls.oauthCredentials).toHaveLength(0);
  });

  test("rejects an expired state", async () => {
    const ctx = contextWith(
      withGrant({ access_token: "at_1", refresh_token: "rt_1" })
    );
    const { connectorId, state } = await authorized(ctx);
    await db
      .update(connectorOauthFlows)
      .set({ expiresAt: new Date(Date.now() - HOUR_MS) })
      .where(eq(connectorOauthFlows.connectorId, connectorId));

    expect(completeOAuthCallback(ctx, { code: "c", state })).rejects.toThrow(
      STATE_EXPIRED
    );
  });

  test("a replayed callback finds nothing - the state is single-use", async () => {
    const ctx = contextWith(
      withGrant({ access_token: "at_1", refresh_token: "rt_1" })
    );
    const { state } = await authorized(ctx);

    await completeOAuthCallback(ctx, { code: "c", state });
    expect(
      completeOAuthCallback(ctx, { code: "c", state })
    ).rejects.toBeInstanceOf(ConnectorFlowError);
    expect(vaults.calls.oauthCredentials).toHaveLength(1);
  });

  test("a refused exchange marks auth_error and stores nothing", async () => {
    const ctx = contextWith(
      world([
        mcpHandler("at_1"),
        metadataHandler(),
        registrationHandler(),
        tokenHandler({ error: "invalid_grant" }, 400),
      ])
    );
    const { connectorId, state } = await authorized(ctx);

    expect(completeOAuthCallback(ctx, { code: "c", state })).rejects.toThrow(
      REFUSED_GRANT
    );
    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);
    expect(stored?.status).toBe("auth_error");
    expect(stored?.mgmtAccessTokenEnc).toBeNull();
  });

  test("re-authorizing updates the existing credential's secrets in place", async () => {
    const ctx = contextWith(
      withGrant({
        access_token: "at_1",
        expires_in: 3600,
        refresh_token: "rt_1",
      })
    );
    const first = await authorized(ctx);
    await completeOAuthCallback(ctx, { code: "c", state: first.state });

    const connector = await getConnector(
      db,
      DEFAULT_WORKSPACE_ID,
      first.connectorId
    );
    if (!connector) {
      throw new Error("Expected the connector.");
    }
    const outcome = await beginReauthorization(ctx, connector);
    expect(outcome.kind).toBe("authorize");

    const flow = await flowFor(connector.id);
    await completeOAuthCallback(ctx, { code: "c2", state: flow?.state ?? "" });

    // One vault, one credential: the second pass patched rather than created.
    expect(vaults.calls.vaults).toHaveLength(1);
    expect(vaults.calls.oauthCredentials).toHaveLength(1);
    expect(vaults.calls.updates).toEqual([
      { credentialId: "cred_oauth", refreshToken: "rt_1" },
    ]);
  });
});

// --- rung 6: bearer ---------------------------------------------------------

describe("completeBearer", () => {
  test("proves the token, vaults it as static_bearer and caches the tools", async () => {
    const ctx = contextWith(
      world([mcpHandler("tok_paste"), metadataHandler()])
    );
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    const updated = await completeBearer(ctx, connector, "tok_paste");

    expect(updated.status).toBe("connected");
    expect(updated.authKind).toBe("bearer");
    expect(updated.vaultCredentialId).toBe("cred_bearer");
    expect(vaults.calls.bearerCredentials).toEqual([
      { token: "tok_paste", vaultId: "vault_1" },
    ]);
    expect(updated.toolCache?.tools).toHaveLength(1);
    expect(await decryptSecret(KEY, updated.mgmtAccessTokenEnc ?? "")).toBe(
      "tok_paste"
    );
  });

  test("a token the server rejects is never stored", async () => {
    const ctx = contextWith(world([mcpHandler("right"), metadataHandler()]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    expect(completeBearer(ctx, connector, "wrong")).rejects.toThrow();
    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(stored?.mgmtAccessTokenEnc).toBeNull();
    expect(stored?.authKind).not.toBe("bearer");
    expect(vaults.calls.bearerCredentials).toHaveLength(0);
  });
});

// --- test connection --------------------------------------------------------

describe("testConnection", () => {
  const connected = async (
    fetchImpl: typeof fetch,
    grant: Record<string, unknown>
  ) => {
    const setup = contextWith(
      world([
        mcpHandler("at_1"),
        metadataHandler(),
        registrationHandler(),
        tokenHandler(grant),
      ])
    );
    const { connectorId, state } = await authorized(setup);
    await completeOAuthCallback(setup, { code: "c", state });
    return { connectorId, ctx: contextWith(fetchImpl) };
  };

  test("lists tools with a live management token", async () => {
    const { ctx, connectorId } = await connected(
      world([mcpHandler("at_1", ["x", "y"])]),
      { access_token: "at_1", expires_in: 3600, refresh_token: "rt_1" }
    );
    const connector = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);

    const result = await testConnection(ctx, must(connector, "the connector"));

    expect(result.ok).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(["x", "y"]);
  });

  test("refreshes an expired management token before probing", async () => {
    const { ctx, connectorId } = await connected(
      world([
        mcpHandler("at_2", ["after-refresh"]),
        tokenHandler({
          access_token: "at_2",
          expires_in: 3600,
          refresh_token: "rt_2",
        }),
      ]),
      // Already expired when it was stored.
      { access_token: "at_1", expires_in: -10, refresh_token: "rt_1" }
    );
    const connector = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);

    const result = await testConnection(ctx, must(connector, "the connector"));

    expect(result.ok).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(["after-refresh"]);
    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);
    expect(await decryptSecret(KEY, stored?.mgmtAccessTokenEnc ?? "")).toBe(
      "at_2"
    );
    expect(stored?.mgmtError).toBeNull();
  });

  test("a failed refresh degrades to mgmtError and leaves status alone", async () => {
    const { ctx, connectorId } = await connected(
      world([tokenHandler({ error: "invalid_grant" }, 400)]),
      { access_token: "at_1", expires_in: -10, refresh_token: "rt_1" }
    );
    const connector = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);

    const result = await testConnection(ctx, must(connector, "the connector"));

    expect(result.ok).toBe(false);
    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);
    // The vault credential is untouched, so every session keeps working.
    expect(stored?.status).toBe("connected");
    expect(stored?.mgmtError).toMatch(MANAGEMENT_REAUTH);
    expect(stored?.lastError).toBeNull();
  });

  test("an OAuth connector rejected at the server is a management problem only", async () => {
    const { ctx, connectorId } = await connected(
      world([mcpHandler("some-other-token")]),
      { access_token: "at_1", expires_in: 3600, refresh_token: "rt_1" }
    );
    const connector = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);

    await testConnection(ctx, must(connector, "the connector"));

    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);
    expect(stored?.status).toBe("connected");
    expect(stored?.mgmtError).toMatch(MANAGEMENT_REAUTH);
  });

  test("a bearer connector rejected at the server really is broken", async () => {
    const setup = contextWith(world([mcpHandler("tok"), metadataHandler()]));
    const { connector } = await addConnector(setup, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    await completeBearer(setup, connector, "tok");

    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    const ctx = contextWith(world([mcpHandler("revoked")]));
    const result = await testConnection(
      ctx,
      must(stored, "the stored connector")
    );

    expect(result.ok).toBe(false);
    const after = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(after?.status).toBe("auth_error");
    expect(after?.lastError).not.toBeNull();
  });

  test("a good test clears a previous auth_error", async () => {
    const setup = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(setup, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    await db
      .update(connectors)
      .set({ lastError: "old", status: "auth_error" })
      .where(eq(connectors.id, connector.id));

    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(
      (await testConnection(setup, must(stored, "the stored connector"))).ok
    ).toBe(true);
    const after = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    expect(after?.status).toBe("connected");
    expect(after?.lastError).toBeNull();
  });
});

// --- disable, assignment, removal -------------------------------------------

describe("setConnectorDisabled", () => {
  test("disables, then restores the status the credential implies", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    const disabled = await setConnectorDisabled(ctx, connector, true);
    expect(disabled?.status).toBe("disabled");

    const enabled = await setConnectorDisabled(
      ctx,
      must(disabled, "the disabled connector"),
      false
    );
    expect(enabled?.status).toBe("connected");
  });

  test("an unauthorized connector comes back unconfigured, not connected", async () => {
    const ctx = contextWith(world([mcpHandler("at_1"), metadataHandler()]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    const disabled = await setConnectorDisabled(ctx, connector, true);
    const enabled = await setConnectorDisabled(
      ctx,
      must(disabled, "the disabled connector"),
      false
    );
    expect(enabled?.status).toBe("unconfigured");
  });
});

describe("agent assignment", () => {
  test("assigns, lists both ways and unassigns", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    await assignConnector(db, connector.id, "agent_1");
    // Assigning twice is not an error - the pair is unique.
    await assignConnector(db, connector.id, "agent_1");
    await assignConnector(db, connector.id, "agent_2");

    expect((await listAgentIdsForConnector(db, connector.id)).sort()).toEqual([
      "agent_1",
      "agent_2",
    ]);
    expect(
      (await listConnectorsForAgent(db, "agent_1")).map((row) => row.id)
    ).toEqual([connector.id]);

    expect(await unassignConnector(db, connector.id, "agent_1")).toBe(true);
    expect(await unassignConnector(db, connector.id, "agent_1")).toBe(false);
    expect(await listConnectorsForAgent(db, "agent_1")).toEqual([]);
  });
});

describe("removeConnector", () => {
  test("deletes the vault, the assignments and the row", async () => {
    const ctx = contextWith(
      world([
        mcpHandler("at_1"),
        metadataHandler(),
        registrationHandler(),
        tokenHandler({ access_token: "at_1", refresh_token: "rt_1" }),
      ])
    );
    const { connectorId, state } = await authorized(ctx);
    await completeOAuthCallback(ctx, { code: "c", state });
    await assignConnector(db, connectorId, "agent_1");

    const connector = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);
    const { vaultError } = await removeConnector(
      ctx,
      must(connector, "the connector")
    );

    expect(vaultError).toBeNull();
    // One call, no archive step - the spike confirmed a live vault deletes.
    expect(vaults.calls.deleted).toEqual(["vault_1"]);
    expect(
      await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId)
    ).toBeUndefined();
    expect(await listConnectorsForAgent(db, "agent_1")).toEqual([]);
    expect(await flowFor(connectorId)).toBeUndefined();
  });

  test("removes the rows even when the vault call fails", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    await db
      .update(connectors)
      .set({ vaultId: "vault_orphan" })
      .where(eq(connectors.id, connector.id));
    vaults.gateway.deleteVault = () => Promise.reject(new Error("vault gone"));

    const stored = await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id);
    const { vaultError } = await removeConnector(
      ctx,
      must(stored, "the stored connector")
    );

    expect(vaultError).toBe("vault gone");
    expect(
      await getConnector(db, DEFAULT_WORKSPACE_ID, connector.id)
    ).toBeUndefined();
  });

  test("a connector added with the integration off has no vault to delete", async () => {
    const ctx: ConnectorContext = {
      ...contextWith(world([mcpHandler(null)])),
      vaults: null,
    };
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    expect(connector.status).toBe("connected");
    expect((await removeConnector(ctx, connector)).vaultError).toBeNull();
    expect(vaults.calls.deleted).toEqual([]);
  });
});

// --- agent wiring -----------------------------------------------------------

/**
 * What a connector change owes the agents holding it. The rotation itself lives
 * in `modules/anthropic`; all this side does is record the debt, and it must
 * record it exactly when the agent's `mcp_servers` array would come out
 * different - a needless rotation costs the agent its workspace MCP URL.
 */
describe("marking agents for a connector resync", () => {
  const anAgent = async (name = "Ada"): Promise<string> => {
    const { agent } = await createAgent(db, DEFAULT_WORKSPACE_ID, {
      instructions: "",
      name,
      soul: "",
    });
    return agent.id;
  };

  const isMarked = async (agentId: string): Promise<boolean> => {
    const agent = await getAgentById(db, DEFAULT_WORKSPACE_ID, agentId);
    return agent?.connectorResyncPendingAt !== null;
  };

  /** An assigned agent with a clean slate, so the next change is the subject. */
  const holderOf = async (connectorId: string): Promise<string> => {
    const agentId = await anAgent();
    await assignConnector(db, connectorId, agentId);
    await clearConnectorResyncPending(db, agentId);
    return agentId;
  };

  const connected = async (): Promise<string> => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    return connector.id;
  };

  test("assigning marks the agent", async () => {
    const connectorId = await connected();
    const agentId = await anAgent();

    await assignConnector(db, connectorId, agentId);

    expect(await isMarked(agentId)).toBe(true);
  });

  test("assigning something already assigned does not", async () => {
    const connectorId = await connected();
    const agentId = await holderOf(connectorId);

    await assignConnector(db, connectorId, agentId);

    expect(await isMarked(agentId)).toBe(false);
  });

  test("unassigning marks the agent, and a stranger's does not", async () => {
    const connectorId = await connected();
    const agentId = await holderOf(connectorId);
    const other = await anAgent("Grace");

    expect(await unassignConnector(db, connectorId, other)).toBe(false);
    expect(await isMarked(other)).toBe(false);

    await unassignConnector(db, connectorId, agentId);
    expect(await isMarked(agentId)).toBe(true);
  });

  test("the twentieth connector is refused rather than silently dropped", async () => {
    const agentId = await anAgent();
    for (let index = 0; index < MAX_AGENT_CONNECTORS; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture rows are written in order
      await db.insert(connectors).values({
        id: `c${index}`,
        name: `c${index}`,
        status: "connected",
        url: `https://c${index}.example.com/mcp`,
        workspaceId: DEFAULT_WORKSPACE_ID,
      });
      await assignConnector(db, `c${index}`, agentId);
    }
    const extra = await connected();

    expect(assignConnector(db, extra, agentId)).rejects.toThrow(
      ConnectorCapError
    );
  });

  test("renaming a connector changes no agent's servers", async () => {
    const connectorId = await connected();
    const agentId = await holderOf(connectorId);

    await renameConnector(contextWith(world([])), connectorId, "Docs");

    expect(await isMarked(agentId)).toBe(false);
  });

  test("disabling and re-enabling both mark", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const connectorId = await connected();
    const agentId = await holderOf(connectorId);

    const stored = must(
      await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId),
      "the connector"
    );
    await setConnectorDisabled(ctx, stored, true);
    expect(await isMarked(agentId)).toBe(true);

    await clearConnectorResyncPending(db, agentId);
    const off = must(
      await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId),
      "the connector"
    );
    await setConnectorDisabled(ctx, off, false);
    expect(await isMarked(agentId)).toBe(true);
  });

  test("a first authorization marks, a repeat of it does not", async () => {
    const ctx = contextWith(
      world([
        mcpHandler("at_1"),
        metadataHandler(),
        registrationHandler(),
        tokenHandler({ access_token: "at_1", refresh_token: "rt_1" }),
      ])
    );
    const { connectorId, state } = await authorized(ctx);
    const agentId = await holderOf(connectorId);

    // Nothing was attachable before: the connector had no credential.
    await completeOAuthCallback(ctx, { code: "c", state });
    expect(await isMarked(agentId)).toBe(true);

    await clearConnectorResyncPending(db, agentId);
    const again = must(
      await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId),
      "the connector"
    );
    await beginReauthorization(ctx, again);
    const flow = must(await flowFor(connectorId), "a second flow");
    await completeOAuthCallback(ctx, { code: "c", state: flow.state });

    // The array would come out identical, so the token stays as it is.
    expect(await isMarked(agentId)).toBe(false);
  });

  test("removing marks the agents that were holding it", async () => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const connectorId = await connected();
    const agentId = await holderOf(connectorId);

    const stored = must(
      await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId),
      "the connector"
    );
    const { agentIds } = await removeConnector(ctx, stored);

    expect(agentIds).toEqual([agentId]);
    expect(await isMarked(agentId)).toBe(true);
  });
});

describe("recordConnectorAuthFailure", () => {
  const attachedTo = async (): Promise<{
    agentId: string;
    connectorId: string;
  }> => {
    const ctx = contextWith(world([mcpHandler(null)]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    const { agent } = await createAgent(db, DEFAULT_WORKSPACE_ID, {
      instructions: "",
      name: "Ada",
      soul: "",
    });
    await assignConnector(db, connector.id, agent.id);
    return { agentId: agent.id, connectorId: connector.id };
  };

  test("a session error naming the connector flips it to auth_error", async () => {
    const { agentId, connectorId } = await attachedTo();
    const server = connectorServerName({ id: connectorId });

    const blamed = await recordConnectorAuthFailure(db, agentId, [
      `MCP server ${server} returned 401 Unauthorized`,
    ]);

    expect(blamed).toEqual([connectorId]);
    const connector = await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId);
    expect(connector?.status).toBe("auth_error");
    expect(connector?.lastError).toContain("401");
  });

  test("an unrelated session error changes nothing", async () => {
    const { agentId, connectorId } = await attachedTo();

    const blamed = await recordConnectorAuthFailure(db, agentId, [
      "the session ran out of budget",
      "mcp.example.com timed out",
    ]);

    expect(blamed).toEqual([]);
    expect(
      (await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId))?.status
    ).toBe("connected");
  });

  test("a connector another agent holds is not blamed", async () => {
    const { connectorId } = await attachedTo();
    const { agent } = await createAgent(db, DEFAULT_WORKSPACE_ID, {
      instructions: "",
      name: "Grace",
      soul: "",
    });

    const blamed = await recordConnectorAuthFailure(db, agent.id, [
      "mcp.example.com: 401 Unauthorized",
    ]);

    expect(blamed).toEqual([]);
    expect(
      (await getConnector(db, DEFAULT_WORKSPACE_ID, connectorId))?.status
    ).toBe("connected");
  });
});

// --- tenancy ----------------------------------------------------------------

/**
 * The multi-tenancy question the plan raised as the "vault trap": two
 * workspaces adding the *same* connector URL with *different* OAuth accounts.
 *
 * It is answered by the topology this module already has - one vault per
 * connector row, and `(workspace_id, url)` unique rather than `url` - so the
 * two never share a vault and no session can be handed the other's. These
 * tests are what keeps that true.
 */
describe("vaults across workspaces", () => {
  const otherWorkspace = async (): Promise<string> => {
    const { workspace } = await createWorkspace(db, {
      name: "Beta",
      owner: {
        clerkUserId: "user_2bBobBBBBBBBBBBBBBBBBBBB",
        email: "bob@example.com",
        imageUrl: null,
        name: "Bob",
      },
    });
    return workspace.id;
  };

  test("the same URL in two workspaces gets a vault each, never a shared one", async () => {
    const beta = await otherWorkspace();
    const ctx = contextWith(world([mcpHandler("tok_a"), metadataHandler()]));
    const ctxB = contextWith(world([mcpHandler("tok_b"), metadataHandler()]));

    const { connector: mine } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    const { connector: theirs } = await addConnector(ctxB, beta, {
      url: MCP_URL,
    });

    const connectedA = await completeBearer(ctx, mine, "tok_a");
    const connectedB = await completeBearer(ctxB, theirs, "tok_b");

    expect(connectedA.vaultId).not.toBe(connectedB.vaultId);
    // Each token went into its own workspace's vault - the credentials are
    // keyed by `mcp_server_url`, so a shared vault is where they would collide.
    expect(vaults.calls.bearerCredentials).toEqual([
      { token: "tok_a", vaultId: connectedA.vaultId ?? "" },
      { token: "tok_b", vaultId: connectedB.vaultId ?? "" },
    ]);
    expect(vaults.calls.vaults).toEqual([mine.id, theirs.id]);
  });

  test("the vault is created once, on the first credential, and reused after", async () => {
    const ctx = contextWith(world([mcpHandler("tok_a"), metadataHandler()]));
    const { connector } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });

    // A connector that needs no credential has no vault at all.
    expect(vaults.calls.vaults).toEqual([]);

    const connected = await completeBearer(ctx, connector, "tok_a");
    expect(vaults.calls.vaults).toEqual([connector.id]);

    // A second pass finds the credential already there and creates nothing.
    await completeBearer(ctx, connected, "tok_a");
    expect(vaults.calls.vaults).toEqual([connector.id]);
    expect(vaults.calls.bearerCredentials).toHaveLength(1);
  });

  test("removing one workspace's connector leaves the other's vault alone", async () => {
    const beta = await otherWorkspace();
    const ctx = contextWith(world([mcpHandler("tok_a"), metadataHandler()]));
    const ctxB = contextWith(world([mcpHandler("tok_b"), metadataHandler()]));

    const { connector: mine } = await addConnector(ctx, DEFAULT_WORKSPACE_ID, {
      url: MCP_URL,
    });
    const { connector: theirs } = await addConnector(ctxB, beta, {
      url: MCP_URL,
    });
    const connectedA = await completeBearer(ctx, mine, "tok_a");
    const connectedB = await completeBearer(ctxB, theirs, "tok_b");

    await removeConnector(ctx, connectedA);

    expect(vaults.calls.deleted).toEqual([connectedA.vaultId ?? ""]);
    expect((await getConnector(db, beta, theirs.id))?.vaultCredentialId).toBe(
      "cred_bearer"
    );
    expect(connectedB.vaultId).not.toBe(connectedA.vaultId);
  });
});
