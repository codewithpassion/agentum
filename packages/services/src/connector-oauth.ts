/**
 * Connecting a connector with OAuth, as a user or as an agent.
 *
 * `start` runs when a signed-in person clicks Connect. It makes sure the
 * connector has an OAuth client (registered on the fly, or typed in), stores
 * the PKCE verifier and a one-shot `state` bound to that person in
 * `oauth_states`, and returns the provider's authorisation URL. `complete`
 * runs at the callback. It deletes the state row first, so a state works once
 * and a refused callback burns it. It then refuses anyone but the initiator,
 * exchanges the code and stores the tokens as the credential for the owner
 * the state names.
 *
 * The credential secret is AES-GCM ciphertext of
 * `{"accessToken": string, "refreshToken": string | null}`, bound to its row.
 * `expiresAt` and `scopes` sit in the clear on the row. The client id, token
 * endpoint and client secret needed to refresh live in `connectors.oauth`.
 */

import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { connectors, oauthStates } from "@repo/db/schema/connectors";
import { eq, lt } from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  findCredentialSlot,
  type CredentialOwner as Owner,
  writeCredential,
} from "./connectors/credential-write.ts";
import { type Fetcher, probeMcpServer } from "./connectors/mcp.ts";
import {
  buildAuthorizeUrl,
  challengeFor,
  chooseTokenEndpointAuth,
  discoverAuthorization,
  exchangeCode,
  generateState,
  generateVerifier,
  OAuthDiscoveryError,
  OAuthTokenError,
  registerClient,
  scopeFor,
} from "./connectors/oauth.ts";
import {
  configFromDiscovery,
  type OAuthClient,
  type OAuthConfig,
  onGoogle,
  parseOAuthConfig,
  type SharedGoogleClient,
  sharedClientApplies,
} from "./connectors/oauth-config.ts";
import { InvalidConnectorUrlError } from "./connectors/url.ts";
import { loadActiveAgent, loadConnector } from "./connectors.ts";
import { decryptSecret, encryptSecret, importSecretsKey } from "./crypto.ts";
import { invalid, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import { requireSession } from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import { idString } from "./shared.ts";
import type { Principal } from "./workspaces.ts";

const CONNECTOR_KIND = "connector";
const START_ACTION = "connectors.oauthStart";
const COMPLETE_ACTION = "connectors.oauthComplete";
const SET_CLIENT_ACTION = "connectors.oauthSetClient";

/** How long a person has to finish at the provider. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Where the provider sends the browser back to, on the app's own origin. */
export const OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";

const CLIENT_NAME = "Agentum";
const AGENT_PREFIX = "agent:";
const WHITESPACE = /\s/;
const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;
const SAME_ORIGIN_PROBE = "https://agentum.invalid";
const SECRET_FIELD_CLIENT = "oauth.clientSecret";
const MAX_RETURN_TO_LENGTH = 2048;
const MAX_ERROR_LENGTH = 300;

export const oauthStartSchema = z.strictObject({
  /** `user`, or `agent:<id>`. */
  as: z.string().min(1).max(250),
  connectorId: idString,
  /** The app's own origin, from the request. The redirect URI is built on it. */
  origin: z.string().min(1).max(300),
  returnTo: z.string().max(MAX_RETURN_TO_LENGTH).optional(),
});
export type OAuthStartInput = z.input<typeof oauthStartSchema>;

export const oauthCompleteSchema = z.strictObject({
  /** The provider's `code`. Absent when it sent an `error` instead. */
  code: z.string().min(1).max(4096).optional(),
  /** The provider's `error` and `error_description`. */
  error: z.string().max(500).optional(),
  state: z.string().min(1).max(500),
});
export type OAuthCompleteInput = z.input<typeof oauthCompleteSchema>;

export const oauthClientSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(2000).optional(),
  connectorId: idString,
});
export type OAuthClientInput = z.input<typeof oauthClientSchema>;

export interface OAuthCompleteResult {
  connectorId: string;
  /** Set when the provider reported an error, such as the person denying access. */
  error: string | null;
  /** A same-origin path with `connected=1` or `connect_error=...` added. */
  returnTo: string;
}

/**
 * Whether `path` is a path on this app and nothing else. A scheme, a host, a
 * protocol-relative `//`, a backslash or any whitespace or control character
 * (browsers strip some of them, which can turn `/\t/host` into `//host`) is
 * refused.
 */
export const isSameOriginPath = (path: string): boolean => {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.length > MAX_RETURN_TO_LENGTH ||
    WHITESPACE.test(path) ||
    [...path].some((char) => {
      const code = char.charCodeAt(0);
      return code <= LAST_CONTROL_CODE || code === DELETE_CODE;
    })
  ) {
    return false;
  }
  try {
    return new URL(path, SAME_ORIGIN_PROBE).origin === SAME_ORIGIN_PROBE;
  } catch {
    return false;
  }
};

/** `path` with one query parameter set. `path` is already a same-origin path. */
const withParam = (path: string, key: string, value: string): string => {
  const url = new URL(path, SAME_ORIGIN_PROBE);
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
};

/** `user` or `agent:<id>`, as the owner of the credential this flow will write. */
const parseOwner = (as: string, userId: string): Owner => {
  if (as === "user") {
    return { id: userId, kind: "user" };
  }
  const agentId = as.startsWith(AGENT_PREFIX)
    ? as.slice(AGENT_PREFIX.length)
    : "";
  if (agentId.length === 0) {
    throw invalid("Connect as `user` or `agent:<id>`.");
  }
  return { id: agentId, kind: "agent" };
};

const defaultReturnTo = (owner: Owner): string =>
  owner.kind === "agent"
    ? `/agents/${encodeURIComponent(owner.id)}?sheet=tools`
    : "/settings/connectors";

export const createConnectorOAuthService = ({
  atomic,
  clock,
  db,
  events,
  fetch: fetchImpl,
  secretsKey,
  sharedGoogleClient,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  fetch: Fetcher;
  /** The deployment's Google OAuth client. Used for connectors on a googleapis.com host with Google endpoints, unless a client was typed in. */
  sharedGoogleClient?: SharedGoogleClient;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Connecting with OAuth needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  /**
   * Reads the tool list with the new token and caches it, as pasting a header
   * credential does. A connector made before sign-in has an empty list, and
   * artifact grants and tool pickers read the cache. Best effort: a server that
   * answers badly leaves the old list.
   */
  const cacheTools = async (
    connector: { id: string; url: string },
    accessToken: string,
    fetchedAt: string
  ): Promise<void> => {
    try {
      const { tools } = await probeMcpServer(connector.url, {
        fetchImpl,
        token: accessToken,
      });
      await db
        .update(connectors)
        .set({ tools: JSON.stringify(tools), toolsFetchedAt: fetchedAt })
        .where(eq(connectors.id, connector.id));
    } catch {
      // The credential is saved; the tool list refreshes on the next connect.
    }
  };

  const saveConfig = async (
    connectorId: string,
    config: OAuthConfig
  ): Promise<void> => {
    await db
      .update(connectors)
      .set({ oauth: JSON.stringify(config) })
      .where(eq(connectors.id, connectorId));
  };

  /** The stored config, or a fresh discovery for a connector that has none. */
  const configFor = async (
    connector: Awaited<ReturnType<typeof loadConnector>>
  ): Promise<OAuthConfig> => {
    const stored = parseOAuthConfig(connector.oauth);
    if (stored) {
      return stored;
    }
    try {
      const found = await discoverAuthorization(connector.url, null, {
        fetchImpl,
      });
      const config = configFromDiscovery(
        found,
        connector.url,
        scopeFor(found.resource, found.metadata)
      );
      await saveConfig(connector.id, config);
      return config;
    } catch (error: unknown) {
      if (
        error instanceof OAuthDiscoveryError ||
        error instanceof InvalidConnectorUrlError
      ) {
        throw invalid(error.message);
      }
      throw error;
    }
  };

  /**
   * The client to authorise with. A typed-in client stays. On Google the
   * deployment's shared client stands in when one is set. A registered one is
   * kept while its redirect URI is still this app's; otherwise (or when there
   * is none) the server is asked to register one.
   */
  const clientFor = async (
    connector: Awaited<ReturnType<typeof loadConnector>>,
    config: OAuthConfig,
    redirectUri: string
  ): Promise<OAuthClient> => {
    const { client } = config;
    if (client?.source === "manual") {
      return client;
    }
    if (
      sharedGoogleClient &&
      sharedClientApplies(config, connector.url, sharedGoogleClient)
    ) {
      // Copied in on every start, so a rotated secret reaches the connector.
      const shared: OAuthClient = {
        clientId: sharedGoogleClient.clientId,
        clientSecret: await encryptSecret(
          await cryptoKey(),
          {
            field: SECRET_FIELD_CLIENT,
            rowId: connector.id,
            table: "connectors",
            workspaceId: connector.workspaceId,
          },
          sharedGoogleClient.clientSecret
        ),
        redirectUri: null,
        source: "shared",
        tokenEndpointAuth: chooseTokenEndpointAuth(
          true,
          config.tokenEndpointAuthMethods
        ),
      };
      await saveConfig(connector.id, { ...config, client: shared });
      return shared;
    }
    if (
      client &&
      client.source !== "shared" &&
      client.redirectUri === redirectUri
    ) {
      return client;
    }
    if (!config.registrationEndpoint) {
      throw invalid(
        "This server does not register clients on its own. Set a client id from its documentation first."
      );
    }
    const key = await cryptoKey();
    let registered: Awaited<ReturnType<typeof registerClient>>;
    try {
      registered = await registerClient(
        config.registrationEndpoint,
        {
          clientName: CLIENT_NAME,
          redirectUri,
          ...(config.scope ? { scope: config.scope } : {}),
          supportedAuthMethods: config.tokenEndpointAuthMethods,
        },
        { fetchImpl }
      );
    } catch (error: unknown) {
      if (
        error instanceof OAuthDiscoveryError ||
        error instanceof InvalidConnectorUrlError
      ) {
        throw invalid(error.message);
      }
      throw error;
    }
    const created: OAuthClient = {
      clientId: registered.clientId,
      clientSecret: registered.clientSecret
        ? await encryptSecret(
            key,
            {
              field: SECRET_FIELD_CLIENT,
              rowId: connector.id,
              table: "connectors",
              workspaceId: connector.workspaceId,
            },
            registered.clientSecret
          )
        : null,
      redirectUri,
      source: "registered",
      tokenEndpointAuth: registered.tokenEndpointAuthMethod,
    };
    await saveConfig(connector.id, { ...config, client: created });
    return created;
  };

  /**
   * Starts the flow for a signed-in person and returns where to send their
   * browser. Nothing is stored for a request that is refused.
   */
  const start = async (
    principal: Principal,
    input: OAuthStartInput
  ): Promise<{ authorizeUrl: string }> => {
    const user = requireSession(principal, START_ACTION);
    const parsed = oauthStartSchema.parse(input);
    const { workspaceId } = user;
    authorize(user, START_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId,
    });
    const owner = parseOwner(parsed.as, user.userId);
    const returnTo = parsed.returnTo ?? defaultReturnTo(owner);
    if (!isSameOriginPath(returnTo)) {
      throw invalid("return_to must be a path on this site.");
    }
    const connector = await loadConnector(db, parsed.connectorId, workspaceId);
    if (owner.kind === "agent") {
      await loadActiveAgent(db, owner.id, workspaceId);
    }
    if (connector.authKind !== "oauth") {
      throw invalid("That connector does not use OAuth.");
    }

    const redirectUri = `${parsed.origin}${OAUTH_CALLBACK_PATH}`;
    const config = await configFor(connector);
    const client = await clientFor(connector, config, redirectUri);

    const state = generateState();
    const verifier = generateVerifier();
    const now = clock.now();
    await db.insert(oauthStates).values({
      connectorId: connector.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
      initiatorUserId: user.userId,
      ownerId: owner.id,
      ownerKind: owner.kind,
      redirectUri,
      returnTo,
      state,
      verifier,
      workspaceId,
    });
    return {
      authorizeUrl: buildAuthorizeUrl({
        authorizationEndpoint: config.authorizationEndpoint,
        challenge: await challengeFor(verifier),
        clientId: client.clientId,
        redirectUri,
        resource: config.resource,
        scope: config.scope,
        state,
      }),
    };
  };

  const clientCredentials = async (
    connector: Awaited<ReturnType<typeof loadConnector>>,
    client: OAuthClient
  ) => ({
    clientId: client.clientId,
    clientSecret: client.clientSecret
      ? await decryptSecret(
          await cryptoKey(),
          {
            field: SECRET_FIELD_CLIENT,
            rowId: connector.id,
            table: "connectors",
            workspaceId: connector.workspaceId,
          },
          client.clientSecret
        )
      : null,
    tokenEndpointAuth: client.tokenEndpointAuth,
  });

  /** Exchanges the code and writes the credential. Throws invalid refusals. */
  const store = async (
    user: ReturnType<typeof requireSession>,
    row: typeof oauthStates.$inferSelect,
    code: string
  ): Promise<void> => {
    const now = clock.now();
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      throw invalid("This connect link has expired. Start again.");
    }
    const connector = await loadConnector(db, row.connectorId, row.workspaceId);
    const owner: Owner = { id: row.ownerId, kind: row.ownerKind };
    if (owner.kind === "agent") {
      await loadActiveAgent(db, owner.id, row.workspaceId);
    }
    const config = parseOAuthConfig(connector.oauth);
    if (!config?.client) {
      throw invalid("This connector has no OAuth client. Start again.");
    }
    if (config.client.source === "shared" && !onGoogle(config, connector.url)) {
      throw invalid("This connector has no OAuth client. Start again.");
    }

    let tokens: Awaited<ReturnType<typeof exchangeCode>>;
    try {
      tokens = await exchangeCode(
        config.tokenEndpoint,
        await clientCredentials(connector, config.client),
        {
          code,
          redirectUri: row.redirectUri,
          resource: config.resource,
          verifier: row.verifier,
        },
        { fetchImpl, nowMs: () => now.getTime() }
      );
    } catch (error: unknown) {
      if (
        error instanceof OAuthTokenError ||
        error instanceof InvalidConnectorUrlError
      ) {
        throw invalid(error.message);
      }
      throw error;
    }

    const key = await cryptoKey();
    const slot = await findCredentialSlot(
      db,
      connector.id,
      owner,
      now.getTime()
    );
    const secret = await encryptSecret(
      key,
      {
        field: "secret",
        rowId: slot.id,
        table: "credentials",
        workspaceId: row.workspaceId,
      },
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })
    );
    await writeCredential(
      { atomic, db },
      {
        alongside: db
          .update(connectors)
          .set({ status: "ok" })
          .where(eq(connectors.id, connector.id)),
        connectorId: connector.id,
        createdBy: user.userId,
        expiresAt: tokens.expiresAt.toISOString(),
        now: now.toISOString(),
        owner,
        scopes: tokens.scope ?? config.scope,
        secret,
        slot,
        workspaceId: row.workspaceId,
      }
    );
    await cacheTools(connector, tokens.accessToken, now.toISOString());
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: owner.kind === "agent" ? owner.id : null,
      payload: {
        connectorId: connector.id,
        ownerId: owner.id,
        ownerKind: owner.kind,
        replaced: slot.version !== null,
        via: "oauth",
      },
      type: "credential.created",
      workspaceId: row.workspaceId,
    });
  };

  /**
   * Finishes the flow at the callback. The state row is deleted before
   * anything else is checked. Throws `ForbiddenError` when the caller is not
   * the person who started it, and an invalid `ServiceError` for an unknown or
   * used state. Once the person is confirmed, a provider error or a refused
   * code comes back as `error` and `returnTo` carries it as `connect_error`.
   */
  const complete = async (
    principal: Principal,
    input: OAuthCompleteInput
  ): Promise<OAuthCompleteResult> => {
    const user = requireSession(principal, COMPLETE_ACTION);
    const parsed = oauthCompleteSchema.parse(input);
    const [row] = await db
      .delete(oauthStates)
      .where(eq(oauthStates.state, parsed.state))
      .returning();
    if (!row) {
      throw invalid(
        "This connect link was already used or has expired. Start again."
      );
    }
    if (
      row.initiatorUserId !== user.userId ||
      row.workspaceId !== user.workspaceId
    ) {
      throw new ForbiddenError(COMPLETE_ACTION);
    }
    authorize(user, COMPLETE_ACTION, {
      id: row.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId: row.workspaceId,
    });
    const finish = (error: string | null): OAuthCompleteResult => ({
      connectorId: row.connectorId,
      error,
      returnTo: error
        ? withParam(
            row.returnTo,
            "connect_error",
            error.slice(0, MAX_ERROR_LENGTH)
          )
        : withParam(row.returnTo, "connected", "1"),
    });
    // From here the person is the right one and the state is spent, so a
    // refusal goes back to the page they came from with its reason.
    try {
      if (parsed.error !== undefined || parsed.code === undefined) {
        return finish(parsed.error ?? "The provider sent no code.");
      }
      await store(user, row, parsed.code);
      return finish(null);
    } catch (error: unknown) {
      if (
        error instanceof ServiceError &&
        (error.code === "invalid" || error.code === "conflict")
      ) {
        return finish(error.message);
      }
      throw error;
    }
  };

  /**
   * Types in the OAuth client for a server that does not register clients on
   * its own. Replaces any client the connector had.
   */
  const setClient = async (
    principal: Principal,
    input: OAuthClientInput
  ): Promise<void> => {
    const user = requireSession(principal, SET_CLIENT_ACTION);
    const parsed = oauthClientSchema.parse(input);
    authorize(user, SET_CLIENT_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    const connector = await loadConnector(
      db,
      parsed.connectorId,
      user.workspaceId
    );
    if (connector.authKind !== "oauth") {
      throw invalid("That connector does not use OAuth.");
    }
    const key = await cryptoKey();
    const config = await configFor(connector);
    await saveConfig(connector.id, {
      ...config,
      client: {
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret
          ? await encryptSecret(
              key,
              {
                field: SECRET_FIELD_CLIENT,
                rowId: connector.id,
                table: "connectors",
                workspaceId: connector.workspaceId,
              },
              parsed.clientSecret
            )
          : null,
        redirectUri: null,
        source: "manual",
        tokenEndpointAuth: chooseTokenEndpointAuth(
          parsed.clientSecret !== undefined,
          config.tokenEndpointAuthMethods
        ),
      },
    });
  };

  /** Deletes the flows nobody finished. The minute tick calls it. */
  const purgeExpired = async (): Promise<number> => {
    const gone = await db
      .delete(oauthStates)
      .where(lt(oauthStates.expiresAt, clock.now().toISOString()))
      .returning({ state: oauthStates.state });
    return gone.length;
  };

  return { complete, purgeExpired, setClient, start };
};

export type ConnectorOAuthService = ReturnType<
  typeof createConnectorOAuthService
>;
