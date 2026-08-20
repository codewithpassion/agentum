import { and, asc, eq, inArray } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "#/crypto";
import type { Db } from "#/db/client";
import { markAgentsForConnectorResync } from "#/modules/agents/service";
import type { VaultGateway } from "#/modules/anthropic/vaults";
import { connectorsFailingAuth } from "./health";
import {
  McpError,
  type McpProbeResult,
  McpUnauthorizedError,
  probeMcpServer,
} from "./mcp";
import {
  type AuthorizationServerMetadata,
  buildAuthorizeUrl,
  type ClientCredentials,
  challengeFor,
  chooseTokenEndpointAuth,
  discoverAuthorization,
  exchangeCode,
  generateState,
  generateVerifier,
  type OAuthTokens,
  refreshTokens,
  registerClient,
  scopeFor,
} from "./oauth";
import {
  agentConnectors,
  type Connector,
  type ConnectorOauthFlow,
  connectorOauthFlows,
  connectors,
  type TokenEndpointAuthMethod,
  type ToolCache,
} from "./schema";
import { canonicalizeConnectorUrl } from "./url";
import { isConnectorUsable, MAX_AGENT_CONNECTORS } from "./usability";

/**
 * The connector lifecycle: probe, authorize, store, test, remove.
 *
 * Everything the outside world varies - the database, the Anthropic vaults, the
 * encryption key, `fetch` - arrives in a `ConnectorContext`, which is what lets
 * the whole ladder be exercised against fakes.
 */

const FLOW_TTL_MS = 10 * 60 * 1000;
/** Refresh a little early: a token about to expire is a failed call in flight. */
const EXPIRY_SKEW_MS = 60 * 1000;

export interface ConnectorContext {
  db: Db;
  fetchImpl?: typeof fetch;
  /** `CONNECTOR_KEY`; null when unset, which only no-auth connectors survive. */
  key: string | null;
  redirectUri: string;
  /** Null when the Anthropic integration is off - see `createVaults`. */
  vaults: VaultGateway | null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const requireKey = (ctx: ConnectorContext): string => {
  if (!ctx.key) {
    throw new Error(
      "CONNECTOR_KEY is not configured. Set it (a base64 32-byte key) before adding an authenticated connector."
    );
  }
  return ctx.key;
};

// --- reads ------------------------------------------------------------------

/** The shape every transport may hand out: no `*_enc` column ever leaves here. */
export interface ConnectorView {
  authKind: Connector["authKind"];
  createdAt: Date;
  hasVaultCredential: boolean;
  id: string;
  lastError: string | null;
  name: string;
  /**
   * The management copy has gone stale - typically a refresh token the server
   * rotated. Sessions are unaffected, which is why this is not a status.
   */
  needsManagementReauth: boolean;
  status: Connector["status"];
  toolCache: ToolCache | null;
  updatedAt: Date;
  url: string;
}

export const toConnectorView = (connector: Connector): ConnectorView => ({
  authKind: connector.authKind,
  createdAt: connector.createdAt,
  hasVaultCredential: connector.vaultCredentialId !== null,
  id: connector.id,
  lastError: connector.lastError,
  name: connector.name,
  needsManagementReauth: connector.mgmtError !== null,
  status: connector.status,
  toolCache: connector.toolCache ?? null,
  updatedAt: connector.updatedAt,
  url: connector.url,
});

export const listConnectors = (
  db: Db,
  workspaceId: string
): Promise<Connector[]> =>
  db
    .select()
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId))
    .orderBy(asc(connectors.name));

export const getConnector = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<Connector | undefined> => {
  const [connector] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.workspaceId, workspaceId), eq(connectors.id, id)));
  return connector;
};

/** Every connector of one workspace, for the workspace-delete cleanup. */
export const deleteConnectorsForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  const rows = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    // `agent_connectors` has no foreign key, so the assignments go by hand.
    await db
      .delete(agentConnectors)
      .where(inArray(agentConnectors.connectorId, ids));
  }
  await db
    .delete(connectorOauthFlows)
    .where(eq(connectorOauthFlows.workspaceId, workspaceId));
  await db.delete(connectors).where(eq(connectors.workspaceId, workspaceId));
};

// --- agent assignment -------------------------------------------------------

export const listAgentIdsForConnector = async (
  db: Db,
  connectorId: string
): Promise<string[]> => {
  const rows = await db
    .select({ agentId: agentConnectors.agentId })
    .from(agentConnectors)
    .where(eq(agentConnectors.connectorId, connectorId));
  return rows.map((row) => row.agentId);
};

/**
 * Marking an agent means: rotate its MCP token and push a fresh `mcp_servers`
 * array, once it has no session. Only `modules/anthropic` can do that (it owns
 * the API client), so the connector module records the debt and the resync
 * runs from there - which is also what makes it survive a failed attempt.
 */
export const markConnectorAgentsForResync = async (
  db: Db,
  connectorId: string
): Promise<string[]> => {
  const agentIds = await listAgentIdsForConnector(db, connectorId);
  await markAgentsForConnectorResync(db, agentIds);
  return agentIds;
};

/**
 * A connector whose usability did not change needs no resync: the agent's
 * `mcp_servers` array would come out identical, and rotating its token for
 * nothing costs it the workspace MCP mid-flight.
 */
const markIfUsabilityChanged = async (
  db: Db,
  before: Connector,
  after: Connector | undefined
): Promise<void> => {
  if (!after || isConnectorUsable(before) === isConnectorUsable(after)) {
    return;
  }
  await markConnectorAgentsForResync(db, before.id);
};

/** What `syncAgent` and session create read: every connector on the agent. */
export const listConnectorsForAgent = async (
  db: Db,
  agentId: string
): Promise<Connector[]> => {
  const rows = await db
    .select({ connector: connectors })
    .from(agentConnectors)
    .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
    .where(eq(agentConnectors.agentId, agentId))
    .orderBy(asc(connectors.name));
  return rows.map((row) => row.connector);
};

/** The 20-`mcp_servers` cap, refused where a human can still do something. */
export class ConnectorCapError extends Error {}

export const assignConnector = async (
  db: Db,
  connectorId: string,
  agentId: string
): Promise<void> => {
  const assigned = await db
    .select({ connectorId: agentConnectors.connectorId })
    .from(agentConnectors)
    .where(eq(agentConnectors.agentId, agentId));

  if (assigned.some((row) => row.connectorId === connectorId)) {
    // Already there: re-marking would rotate the agent's token for no change.
    return;
  }
  if (assigned.length >= MAX_AGENT_CONNECTORS) {
    throw new ConnectorCapError(
      `An agent can use at most ${MAX_AGENT_CONNECTORS} connectors. Remove one before adding another.`
    );
  }

  await db
    .insert(agentConnectors)
    .values({ agentId, connectorId, id: crypto.randomUUID() })
    .onConflictDoNothing();
  await markAgentsForConnectorResync(db, [agentId]);
};

export const unassignConnector = async (
  db: Db,
  connectorId: string,
  agentId: string
): Promise<boolean> => {
  const removed = await db
    .delete(agentConnectors)
    .where(
      and(
        eq(agentConnectors.connectorId, connectorId),
        eq(agentConnectors.agentId, agentId)
      )
    )
    .returning({ id: agentConnectors.id });
  if (removed.length === 0) {
    return false;
  }
  await markAgentsForConnectorResync(db, [agentId]);
  return true;
};

// --- writes -----------------------------------------------------------------

const patch = async (
  db: Db,
  id: string,
  values: Partial<typeof connectors.$inferInsert>
): Promise<Connector | undefined> => {
  const [connector] = await db
    .update(connectors)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(connectors.id, id))
    .returning();
  return connector;
};

const cacheOf = (probe: McpProbeResult): ToolCache => ({
  fetchedAt: Date.now(),
  tools: probe.tools,
});

// --- the ladder -------------------------------------------------------------

/** What the caller must do next, once the pasted URL has been probed. */
export type StartOutcome =
  /** Rung 1: the server wanted nothing. Nothing to store, nothing to vault. */
  | { kind: "connected" }
  /** Rung 4: send the human here, then wait for the callback. */
  | { kind: "authorize"; authorizeUrl: string }
  /** Rung 3, no dynamic registration: the dialog has to ask for a client id. */
  | { kind: "needs_client"; issuer: string }
  /** Rung 6: no usable OAuth. A pasted bearer token is the way in. */
  | { kind: "needs_bearer"; message: string };

const probeUnauthenticated = (
  ctx: ConnectorContext,
  url: string
): Promise<McpProbeResult> => probeMcpServer(url, { fetchImpl: ctx.fetchImpl });

const startFlow = async (
  ctx: ConnectorContext,
  connector: Connector,
  input: {
    authorizationEndpoint: string;
    clientId: string;
    scope: string | null;
  }
): Promise<string> => {
  const verifier = generateVerifier();
  const state = generateState();

  await ctx.db
    .insert(connectorOauthFlows)
    .values({
      connectorId: connector.id,
      expiresAt: new Date(Date.now() + FLOW_TTL_MS),
      redirectUri: ctx.redirectUri,
      scope: input.scope,
      state,
      verifier,
      workspaceId: connector.workspaceId,
    })
    // One active flow per connector: starting another replaces the first, so a
    // half-finished attempt can never be resumed behind the human's back.
    .onConflictDoUpdate({
      set: {
        expiresAt: new Date(Date.now() + FLOW_TTL_MS),
        redirectUri: ctx.redirectUri,
        scope: input.scope,
        state,
        verifier,
      },
      target: connectorOauthFlows.connectorId,
    });

  return buildAuthorizeUrl({
    authorizationEndpoint: input.authorizationEndpoint,
    challenge: await challengeFor(verifier),
    clientId: input.clientId,
    redirectUri: ctx.redirectUri,
    resource: connector.url,
    scope: input.scope,
    state,
  });
};

export interface ManualClient {
  clientId: string;
  clientSecret?: string | null;
}

interface ResolvedClient {
  authMethod: TokenEndpointAuthMethod;
  clientId: string;
  /** Null when the secret is already on the row, encrypted, and unchanged. */
  clientSecret: string | null;
}

/**
 * Where the OAuth client comes from, in order of authority: what the human just
 * typed, what we already registered, then dynamic registration. Null means the
 * server offers none of the three and the dialog has to ask.
 */
const resolveClient = async (
  ctx: ConnectorContext,
  connector: Connector,
  metadata: AuthorizationServerMetadata,
  scope: string | null,
  manual: ManualClient | undefined
): Promise<ResolvedClient | null> => {
  if (manual) {
    const clientSecret = manual.clientSecret ?? null;
    return {
      authMethod: chooseTokenEndpointAuth(
        Boolean(clientSecret),
        metadata.tokenEndpointAuthMethods
      ),
      clientId: manual.clientId,
      clientSecret,
    };
  }

  if (connector.oauthClientId) {
    return {
      authMethod: connector.oauthTokenEndpointAuth ?? "none",
      clientId: connector.oauthClientId,
      clientSecret: null,
    };
  }

  if (!metadata.registrationEndpoint) {
    return null;
  }

  const registered = await registerClient(
    metadata.registrationEndpoint,
    {
      clientName: "Agentum",
      redirectUri: ctx.redirectUri,
      supportedAuthMethods: metadata.tokenEndpointAuthMethods,
      ...(scope ? { scope } : {}),
    },
    { fetchImpl: ctx.fetchImpl }
  );
  return {
    authMethod: registered.tokenEndpointAuthMethod,
    clientId: registered.clientId,
    clientSecret: registered.clientSecret,
  };
};

/**
 * Rungs 2 to 4: discovery, a client (registered, remembered or supplied), then
 * the authorization URL. Shared by "add", "supply a client id" and
 * "re-authorize" - re-authorization re-runs discovery rather than trusting a
 * stored endpoint, because the server's metadata is allowed to move.
 */
export const beginAuthorization = async (
  ctx: ConnectorContext,
  connector: Connector,
  wwwAuthenticate: string | null,
  manual?: ManualClient
): Promise<StartOutcome> => {
  const key = requireKey(ctx);
  const { metadata, resource } = await discoverAuthorization(
    connector.url,
    wwwAuthenticate,
    { fetchImpl: ctx.fetchImpl }
  );
  const scope = scopeFor(resource, metadata);
  const client = await resolveClient(ctx, connector, metadata, scope, manual);

  if (!client) {
    await patch(ctx.db, connector.id, {
      oauthTokenEndpoint: metadata.tokenEndpoint,
      status: "unconfigured",
    });
    return { issuer: metadata.issuer || connector.url, kind: "needs_client" };
  }

  const { authMethod, clientId, clientSecret } = client;
  const updated = await patch(ctx.db, connector.id, {
    authKind: "oauth",
    lastError: null,
    oauthClientId: clientId,
    oauthClientSecretEnc: clientSecret
      ? await encryptSecret(key, clientSecret)
      : (connector.oauthClientSecretEnc ?? null),
    oauthTokenEndpoint: metadata.tokenEndpoint,
    oauthTokenEndpointAuth: authMethod,
    status: "authorizing",
  });

  return {
    authorizeUrl: await startFlow(ctx, updated ?? connector, {
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId,
      scope,
    }),
    kind: "authorize",
  };
};

export interface StartedConnector {
  connector: Connector;
  outcome: StartOutcome;
}

/**
 * Rung 1 and the branch into the rest. The row is written before the probe so
 * that a server which is merely down still appears in the directory with its
 * error, ready to retry or to fall back to a bearer token.
 */
export const addConnector = async (
  ctx: ConnectorContext,
  workspaceId: string,
  input: { name?: string; url: string }
): Promise<StartedConnector> => {
  const url = canonicalizeConnectorUrl(input.url);
  const [created] = await ctx.db
    .insert(connectors)
    .values({
      id: crypto.randomUUID(),
      name: input.name?.trim() || new URL(url).hostname,
      status: "unconfigured",
      url,
      workspaceId,
    })
    .returning();
  if (!created) {
    throw new Error("Failed to create the connector.");
  }

  try {
    const probe = await probeUnauthenticated(ctx, url);
    const connector = await patch(ctx.db, created.id, {
      authKind: "none",
      lastError: null,
      status: "connected",
      toolCache: cacheOf(probe),
    });
    return { connector: connector ?? created, outcome: { kind: "connected" } };
  } catch (error) {
    return await handleProbeFailure(ctx, created, error);
  }
};

const handleProbeFailure = async (
  ctx: ConnectorContext,
  connector: Connector,
  error: unknown
): Promise<StartedConnector> => {
  if (!(error instanceof McpUnauthorizedError)) {
    // Unreachable, or not an MCP server at all. A bearer token will not fix
    // that, but the message says what happened and the row can be retried.
    const failed = await patch(ctx.db, connector.id, {
      lastError: messageOf(error),
      status: "unconfigured",
    });
    return {
      connector: failed ?? connector,
      outcome: { kind: "needs_bearer", message: messageOf(error) },
    };
  }

  // The 401 alone settles that this server needs credentials, whatever
  // discovery goes on to find. Recording it now keeps a connector whose setup
  // failed from later looking like one that never needed auth at all.
  const gated =
    (await patch(ctx.db, connector.id, { authKind: "oauth" })) ?? connector;

  try {
    const outcome = await beginAuthorization(ctx, gated, error.wwwAuthenticate);
    return {
      connector:
        (await getConnector(ctx.db, connector.workspaceId, connector.id)) ??
        gated,
      outcome,
    };
  } catch (discoveryError) {
    const message = messageOf(discoveryError);
    const failed = await patch(ctx.db, connector.id, {
      lastError: message,
      status: "unconfigured",
    });
    return {
      connector: failed ?? connector,
      outcome: { kind: "needs_bearer", message },
    };
  }
};

/**
 * "Re-authorize", and the resume after the human supplies a client id. Both
 * re-probe first: the challenge is where discovery starts, and a server that
 * has since dropped its auth requirement should simply come back connected.
 */
export const beginReauthorization = async (
  ctx: ConnectorContext,
  connector: Connector,
  manual?: ManualClient
): Promise<StartOutcome> => {
  try {
    const probe = await probeUnauthenticated(ctx, connector.url);
    const reprobed = await patch(ctx.db, connector.id, {
      authKind: "none",
      lastError: null,
      mgmtError: null,
      status: "connected",
      toolCache: cacheOf(probe),
    });
    await markIfUsabilityChanged(ctx.db, connector, reprobed);
    return { kind: "connected" };
  } catch (error) {
    if (!(error instanceof McpUnauthorizedError)) {
      throw error;
    }
    return await beginAuthorization(
      ctx,
      connector,
      error.wwwAuthenticate,
      manual
    );
  }
};

// --- the callback -----------------------------------------------------------

export class ConnectorFlowError extends Error {}

/**
 * State validation, kept pure so every branch is testable: the flow must exist,
 * its `state` must match, and it must not have expired. The caller deletes the
 * row before doing anything else, which is what makes a `state` single-use.
 */
export const validateFlow = (
  flow: ConnectorOauthFlow | undefined,
  state: string,
  now: Date
): ConnectorOauthFlow => {
  if (!flow) {
    throw new ConnectorFlowError(
      "This authorization link is not one we are waiting for. Start again from the connector."
    );
  }
  if (flow.state !== state) {
    throw new ConnectorFlowError("The authorization state did not match.");
  }
  if (flow.expiresAt.getTime() <= now.getTime()) {
    throw new ConnectorFlowError(
      "This authorization took too long. Start again from the connector."
    );
  }
  return flow;
};

const credentialsFor = async (
  ctx: ConnectorContext,
  connector: Connector
): Promise<ClientCredentials> => {
  if (!connector.oauthClientId) {
    throw new ConnectorFlowError("This connector has no OAuth client.");
  }
  return {
    clientId: connector.oauthClientId,
    clientSecret: connector.oauthClientSecretEnc
      ? await decryptSecret(requireKey(ctx), connector.oauthClientSecretEnc)
      : null,
    tokenEndpointAuth: connector.oauthTokenEndpointAuth ?? "none",
  };
};

/** Writes the management copy. Never the vault - that is a separate decision. */
const storeManagementTokens = async (
  ctx: ConnectorContext,
  connectorId: string,
  tokens: OAuthTokens
): Promise<void> => {
  const key = requireKey(ctx);
  await patch(ctx.db, connectorId, {
    mgmtAccessTokenEnc: await encryptSecret(key, tokens.accessToken),
    mgmtError: null,
    mgmtExpiresAt: tokens.expiresAt,
    mgmtRefreshTokenEnc: tokens.refreshToken
      ? await encryptSecret(key, tokens.refreshToken)
      : null,
  });
};

/**
 * Puts the credential where sessions will find it: a vault of this connector's
 * own. On a re-authorization the credential already exists and only its secrets
 * move - `mcp_server_url` is immutable, and the URL has not changed.
 */
const syncVaultOAuth = async (
  ctx: ConnectorContext,
  connector: Connector,
  tokens: OAuthTokens,
  credentials: ClientCredentials
): Promise<{ vaultCredentialId: string; vaultId: string } | null> => {
  if (!(ctx.vaults && connector.oauthTokenEndpoint)) {
    return null;
  }

  if (connector.vaultId && connector.vaultCredentialId) {
    await ctx.vaults.updateOAuthSecrets({
      accessToken: tokens.accessToken,
      credentialId: connector.vaultCredentialId,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken,
      vaultId: connector.vaultId,
    });
    return {
      vaultCredentialId: connector.vaultCredentialId,
      vaultId: connector.vaultId,
    };
  }

  const vaultId =
    connector.vaultId ??
    (await ctx.vaults.createVault({
      connectorId: connector.id,
      displayName: `agentum-connector-${connector.name}`,
    }));

  const vaultCredentialId = await ctx.vaults.createOAuthCredential({
    accessToken: tokens.accessToken,
    connectorId: connector.id,
    displayName: connector.name,
    expiresAt: tokens.expiresAt,
    mcpServerUrl: connector.url,
    // Only when the server actually granted one: that block is what Anthropic
    // refreshes with, and an invented one would fail forever.
    refresh: tokens.refreshToken
      ? {
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          refreshToken: tokens.refreshToken,
          scope: tokens.scope,
          tokenEndpoint: connector.oauthTokenEndpoint,
          tokenEndpointAuth: credentials.tokenEndpointAuth,
        }
      : null,
    vaultId,
  });
  return { vaultCredentialId, vaultId };
};

/** Best effort: a connector is connected whether or not its tools listed. */
const refreshToolCache = async (
  ctx: ConnectorContext,
  connectorId: string,
  url: string,
  token: string
): Promise<void> => {
  const probe = await probeMcpServer(url, {
    fetchImpl: ctx.fetchImpl,
    token,
  }).catch(() => null);
  if (probe) {
    await patch(ctx.db, connectorId, { toolCache: cacheOf(probe) });
  }
};

export const completeOAuthCallback = async (
  ctx: ConnectorContext,
  params: { code: string; state: string }
): Promise<Connector> => {
  const [found] = await ctx.db
    .select()
    .from(connectorOauthFlows)
    .where(eq(connectorOauthFlows.state, params.state));
  const flow = validateFlow(found, params.state, new Date());

  // Consumed before the exchange: a replayed callback finds nothing.
  await ctx.db
    .delete(connectorOauthFlows)
    .where(eq(connectorOauthFlows.connectorId, flow.connectorId));

  // The flow row is the credential *and* the scope: it names the workspace the
  // connector belongs to, which is how a callback that carries no session ends
  // up tenant-scoped anyway.
  const connector = await getConnector(
    ctx.db,
    flow.workspaceId,
    flow.connectorId
  );
  if (!connector?.oauthTokenEndpoint) {
    throw new ConnectorFlowError("This connector is no longer configured.");
  }

  const credentials = await credentialsFor(ctx, connector);
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode(
      connector.oauthTokenEndpoint,
      credentials,
      {
        code: params.code,
        redirectUri: flow.redirectUri,
        resource: connector.url,
        verifier: flow.verifier,
      },
      { fetchImpl: ctx.fetchImpl }
    );
  } catch (error) {
    await patch(ctx.db, connector.id, {
      lastError: messageOf(error),
      status: "auth_error",
    });
    throw error;
  }

  await storeManagementTokens(ctx, connector.id, tokens);
  const vault = await syncVaultOAuth(ctx, connector, tokens, credentials);

  const connected = await patch(ctx.db, connector.id, {
    authKind: "oauth",
    lastError: null,
    status: "connected",
    ...(vault ?? {}),
  });
  // A first authorization makes the connector usable, so every agent holding it
  // needs the server added. A re-authorization of a connector that was already
  // attached changes nothing about the array, and rotates nothing.
  await markIfUsabilityChanged(ctx.db, connector, connected);
  await refreshToolCache(ctx, connector.id, connector.url, tokens.accessToken);
  return (
    (await getConnector(ctx.db, connector.workspaceId, connector.id)) ??
    connected ??
    connector
  );
};

// --- rung 6: the bearer escape hatch ----------------------------------------

/**
 * The token is proved against the server before anything is stored: a pasted
 * API key that the MCP server does not accept should fail here, in the dialog,
 * not silently later inside a session.
 */
interface VaultRef {
  vaultCredentialId: string | null;
  vaultId: string | null;
}

/** Creates the vault and its `static_bearer` credential, once, on first use. */
const syncVaultBearer = async (
  ctx: ConnectorContext,
  connector: Connector,
  token: string
): Promise<VaultRef> => {
  const existing: VaultRef = {
    vaultCredentialId: connector.vaultCredentialId,
    vaultId: connector.vaultId,
  };
  if (!ctx.vaults || existing.vaultCredentialId) {
    return existing;
  }

  const vaultId =
    existing.vaultId ??
    (await ctx.vaults.createVault({
      connectorId: connector.id,
      displayName: `agentum-connector-${connector.name}`,
    }));
  return {
    vaultCredentialId: await ctx.vaults.createBearerCredential({
      connectorId: connector.id,
      displayName: connector.name,
      mcpServerUrl: connector.url,
      token,
      vaultId,
    }),
    vaultId,
  };
};

export const completeBearer = async (
  ctx: ConnectorContext,
  connector: Connector,
  token: string
): Promise<Connector> => {
  const key = requireKey(ctx);
  const probe = await probeMcpServer(connector.url, {
    fetchImpl: ctx.fetchImpl,
    token,
  });

  const { vaultCredentialId, vaultId } = await syncVaultBearer(
    ctx,
    connector,
    token
  );

  await ctx.db
    .delete(connectorOauthFlows)
    .where(eq(connectorOauthFlows.connectorId, connector.id));

  const updated = await patch(ctx.db, connector.id, {
    authKind: "bearer",
    lastError: null,
    mgmtAccessTokenEnc: await encryptSecret(key, token),
    mgmtError: null,
    mgmtExpiresAt: null,
    mgmtRefreshTokenEnc: null,
    status: "connected",
    toolCache: cacheOf(probe),
    vaultCredentialId,
    vaultId,
  });
  await markIfUsabilityChanged(ctx.db, connector, updated);
  return updated ?? connector;
};

// --- management-plane token -------------------------------------------------

/**
 * The decrypted management token, refreshed if it has gone stale. Null means
 * "the management copy is unusable": that is recorded in `mgmtError` and the
 * connector's `status` is deliberately left alone, because Anthropic holds its
 * own copy in the vault and every running session keeps working.
 */
const managementToken = async (
  ctx: ConnectorContext,
  connector: Connector
): Promise<string | null> => {
  if (!connector.mgmtAccessTokenEnc) {
    return null;
  }
  const key = requireKey(ctx);
  const fresh =
    connector.mgmtExpiresAt === null ||
    connector.mgmtExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
  if (fresh) {
    return await decryptSecret(key, connector.mgmtAccessTokenEnc);
  }

  if (!(connector.mgmtRefreshTokenEnc && connector.oauthTokenEndpoint)) {
    await patch(ctx.db, connector.id, {
      mgmtError:
        "The management token expired and this server granted no refresh token. Re-authorize to use Test connection and the tool list.",
    });
    return null;
  }

  try {
    const tokens = await refreshTokens(
      connector.oauthTokenEndpoint,
      await credentialsFor(ctx, connector),
      {
        refreshToken: await decryptSecret(key, connector.mgmtRefreshTokenEnc),
        resource: connector.url,
      },
      { fetchImpl: ctx.fetchImpl }
    );
    await storeManagementTokens(ctx, connector.id, tokens);
    return tokens.accessToken;
  } catch (error) {
    // The likely cause is refresh-token rotation: Anthropic refreshed the vault
    // credential and the server invalidated our copy. Management only.
    await patch(ctx.db, connector.id, {
      mgmtError: `Re-authorize for management features: ${messageOf(error)}`,
    });
    return null;
  }
};

export interface TestResult {
  message: string | null;
  ok: boolean;
  tools: ToolCache["tools"];
}

export const testConnection = async (
  ctx: ConnectorContext,
  connector: Connector
): Promise<TestResult> => {
  let token: string | undefined;
  if (connector.authKind !== "none") {
    const resolved = await managementToken(ctx, connector);
    if (!resolved) {
      const reloaded = await getConnector(
        ctx.db,
        connector.workspaceId,
        connector.id
      );
      return {
        message:
          reloaded?.mgmtError ??
          "This connector has no management credential. Re-authorize it.",
        ok: false,
        tools: [],
      };
    }
    token = resolved;
  }

  try {
    const probe = await probeMcpServer(connector.url, {
      fetchImpl: ctx.fetchImpl,
      ...(token ? { token } : {}),
    });
    const tested = await patch(ctx.db, connector.id, {
      lastError: null,
      mgmtError: null,
      toolCache: cacheOf(probe),
      ...(connector.status === "auth_error" ? { status: "connected" } : {}),
    });
    await markIfUsabilityChanged(ctx.db, connector, tested);
    return { message: null, ok: true, tools: probe.tools };
  } catch (error) {
    await recordTestFailure(ctx, connector, error);
    return { message: messageOf(error), ok: false, tools: [] };
  }
};

/**
 * Who owns the failure. For `oauth`, our token is only a copy - a rejection
 * says nothing about the vault credential the sessions use, so it stays in
 * `mgmtError`. For `bearer` and `none` there is no second copy, so the
 * connector really is broken and `status` says so.
 */
const recordTestFailure = async (
  ctx: ConnectorContext,
  connector: Connector,
  error: unknown
): Promise<void> => {
  const message = messageOf(error);
  if (connector.authKind === "oauth" && error instanceof McpUnauthorizedError) {
    await patch(ctx.db, connector.id, {
      mgmtError: `Re-authorize for management features: ${message}`,
    });
    return;
  }
  const rejected =
    error instanceof McpUnauthorizedError ||
    (error instanceof McpError && connector.authKind === "bearer");
  const failed = await patch(ctx.db, connector.id, {
    lastError: message,
    ...(rejected ? { status: "auth_error" as const } : {}),
  });
  await markIfUsabilityChanged(ctx.db, connector, failed);
};

// --- disable / remove -------------------------------------------------------

export const setConnectorDisabled = async (
  ctx: ConnectorContext,
  connector: Connector,
  disabled: boolean
): Promise<Connector | undefined> => {
  if (disabled) {
    const off = await patch(ctx.db, connector.id, { status: "disabled" });
    await markIfUsabilityChanged(ctx.db, connector, off);
    return off;
  }
  // Re-enabling restores the state the credential implies, not the last one:
  // an unauthenticated connector is connected, an unauthorized one is not.
  const status =
    connector.authKind === "none" || connector.vaultCredentialId
      ? "connected"
      : "unconfigured";
  const on = await patch(ctx.db, connector.id, { status });
  await markIfUsabilityChanged(ctx.db, connector, on);
  return on;
};

export const renameConnector = (
  ctx: ConnectorContext,
  id: string,
  name: string
): Promise<Connector | undefined> => patch(ctx.db, id, { name });

/**
 * One `vaults.delete` takes the credential with it - the spike confirmed a
 * vault holding live credentials deletes without an archive step, and that
 * nothing outside that vault is touched. If the vault call fails the rows still
 * go: a connector nobody can see is worse than an orphaned vault.
 */
export const removeConnector = async (
  ctx: ConnectorContext,
  connector: Connector
): Promise<{ agentIds: string[]; vaultError: string | null }> => {
  // Read before the assignment rows go: afterwards there is nothing left to
  // say which agents were holding this connector.
  const agentIds = await listAgentIdsForConnector(ctx.db, connector.id);
  let vaultError: string | null = null;
  if (ctx.vaults && connector.vaultId) {
    vaultError = await ctx.vaults
      .deleteVault(connector.vaultId)
      .then(() => null)
      .catch((error: unknown) => messageOf(error));
  }

  await ctx.db
    .delete(connectorOauthFlows)
    .where(eq(connectorOauthFlows.connectorId, connector.id));
  await ctx.db
    .delete(agentConnectors)
    .where(eq(agentConnectors.connectorId, connector.id));
  await ctx.db.delete(connectors).where(eq(connectors.id, connector.id));
  await markAgentsForConnectorResync(ctx.db, agentIds);

  return { agentIds, vaultError };
};

// --- health -----------------------------------------------------------------

/**
 * What a session's `session.error` texts say about this agent's connectors. A
 * match sets `auth_error` + `lastError`, which is what the UI turns into a
 * "Re-authorize" prompt; everything else is left alone, because most session
 * errors have nothing to do with a connector.
 */
export const recordConnectorAuthFailure = async (
  db: Db,
  agentId: string,
  messages: readonly string[]
): Promise<string[]> => {
  const attached = await listConnectorsForAgent(db, agentId);
  const blamed = new Map<string, { connector: Connector; message: string }>();
  for (const message of messages) {
    for (const connector of connectorsFailingAuth(message, attached)) {
      blamed.set(connector.id, { connector, message });
    }
  }

  for (const { connector, message } of blamed.values()) {
    // A handful at most, and each one is a write the next may depend on.
    // biome-ignore lint/performance/noAwaitInLoops: at most a few connectors per agent
    const failed = await patch(db, connector.id, {
      lastError: message,
      status: "auth_error",
    });
    await markIfUsabilityChanged(db, connector, failed);
  }
  return [...blamed.keys()];
};
