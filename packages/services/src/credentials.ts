/**
 * Which stored login a connector call uses, and keeping it fresh.
 *
 * `resolve` applies the agent's `credential_mode` to the run's
 * `on_behalf_of_user_id`, never to the direct actor:
 *
 * - `user_or_agent` (default): a run for a person uses that person's
 *   credential, a run for nobody uses the agent's. A person without one gets
 *   `needs_auth`, never the agent's credential.
 * - `agent`: always the agent's credential.
 * - `user`: only a person's credential. A run for nobody gets `needs_auth`.
 *
 * A run on a `single_user` machine for anyone but the person who enrolled the
 * machine resolves the agent's credential instead of the person's. The
 * result says so in `note`.
 *
 * A revoked or refused credential is `needs_auth`. An OAuth credential whose
 * `expires_at` is within two minutes is refreshed before it is handed out.
 *
 * Refresh takes the `refreshing_until` lease first (30 s, one conditional
 * UPDATE). Only the winner calls the token endpoint. It writes the new secret
 * behind the version, the lease and `status != 'revoked'`, so a revocation or a
 * re-authorisation, both of which bump `version` and clear the lease, make the
 * stale holder's write change nothing. Losers poll `version` for up to 5 s.
 * `needs_auth` is written only by the lease holder, only when the provider
 * refused, through the same fenced write.
 */
import type { Database } from "@repo/db";
import {
  agentConnectors,
  connectors,
  credentials,
} from "@repo/db/schema/connectors";
import { machines } from "@repo/db/schema/machines";
import { runs } from "@repo/db/schema/runs";
import type {
  ConnectorAuthKind,
  CredentialOwnerKind,
  CredentialStatus,
} from "@repo/db/shared";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import { decodeAllowedTools } from "./connectors/allowed-tools.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import { OAuthTokenError, refreshTokens } from "./connectors/oauth.ts";
import { onGoogle, parseOAuthConfig } from "./connectors/oauth-config.ts";
import { readConnectorSecret } from "./connectors/secret.ts";
import { InvalidConnectorUrlError } from "./connectors/url.ts";
import { decryptSecret, encryptSecret, importSecretsKey } from "./crypto.ts";
import {
  effectiveRunScope,
  scopeAllows,
  scopedTools,
} from "./runs/access-scope.ts";
import type { Clock } from "./runs/types.ts";

/** Refresh ahead when the token expires within this long. */
export const REFRESH_AHEAD_MS = 2 * 60 * 1000;
/** How long a refresh lease holds before the next caller may take it. */
export const REFRESH_LEASE_MS = 30 * 1000;
/** Losers poll for the winner's new version for this long. */
export const REFRESH_WAIT_MS = 5 * 1000;
const POLL_MS = 100;

const DEFAULT_HEADER_NAME = "Authorization";
const SECRET_FIELD_CLIENT = "oauth.clientSecret";
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;

export type ResolveNote = "single_user_machine";

/** Why a credential cannot be used. */
export type NeedsAuthCause =
  | "missing"
  | "needs_auth"
  | "no_person"
  | "revoked"
  | "single_user_machine";

/** The login to send, ready to put on the request. */
interface OwnedCredential {
  expiresAt: string | null;
  /** The header to send with the call. */
  header: { name: string; value: string; redact?: string };
  id: string;
  ownerId: string;
  ownerKind: CredentialOwnerKind;
  version: number;
}

export type DecryptedCredential =
  | OwnedCredential
  | {
      expiresAt: null;
      header: { name: string; value: string; redact?: string };
      id: null;
      ownerId: string;
      ownerKind: "workspace";
      version: number;
    };

export interface NeedsAuth {
  cause: NeedsAuthCause;
  /** An Agentum page, never a provider URL. Null when no person can connect. */
  connectPath: string | null;
  ok: false;
  ownerId: string | null;
  ownerKind: CredentialOwnerKind;
  reason: "needs_auth";
}

export type Resolution =
  | {
      /** Tool names the agent may use through this connector, null for every tool. */
      allowedTools: string[] | null;
      /** Where to send the call. */
      connector: {
        callTimeoutSeconds: number;
        id: string;
        name: string;
        url: string;
      };
      /** Null for a connector that takes no login. */
      credential: DecryptedCredential | null;
      note: ResolveNote | null;
      ok: true;
      ownerKind: CredentialOwnerKind | "workspace" | null;
      version: number | null;
    }
  | { ok: false; reason: "not_assigned" }
  | NeedsAuth
  /** A refresh is under way somewhere else and nothing newer arrived in time. */
  | { ok: false; reason: "retry" };

export type Refreshed =
  | { credential: OwnedCredential; ok: true }
  | NeedsAuth
  | { ok: false; reason: "retry" };

export interface ResolveInput {
  agentId: string;
  connectorId: string;
  /** The machine running the run, for the `single_user` rule. */
  machineId?: string | null;
  onBehalfOfUserId: string | null;
  runId?: string;
  workspaceId: string;
}

export interface RefreshInput {
  credentialId: string;
  /** Skip the wait for a refresh that someone else is doing. */
  noWait?: boolean;
  /** The version the caller used and was refused with. */
  seenVersion: number;
  workspaceId: string;
}

type CredentialRow = typeof credentials.$inferSelect;
type ConnectorRow = typeof connectors.$inferSelect;
interface Owner {
  id: string | null;
  kind: CredentialOwnerKind;
}

const oauthSecretSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
});

/** `/connect/:id?as=user` or `?as=agent:<id>`: a signed-in Agentum page. */
export const connectPathFor = (
  connectorId: string,
  owner: { id: string | null; kind: CredentialOwnerKind }
): string =>
  owner.kind === "agent" && owner.id
    ? `/connect/${connectorId}?as=agent:${encodeURIComponent(owner.id)}`
    : `/connect/${connectorId}?as=user`;

const needsAuth = (
  connectorId: string,
  owner: Owner,
  cause: NeedsAuthCause
): NeedsAuth => ({
  cause,
  // Connecting would not help when the machine, not the login, is the problem.
  connectPath:
    owner.id === null || cause === "single_user_machine"
      ? null
      : connectPathFor(connectorId, owner),
  ok: false,
  ownerId: owner.id,
  ownerKind: owner.kind,
  reason: "needs_auth",
});

const causeOf = (status: CredentialStatus): NeedsAuthCause =>
  status === "revoked" ? "revoked" : "needs_auth";

/** A token endpoint that said no, as opposed to one that could not be reached. */
const isRefusal = (error: unknown): boolean =>
  error instanceof InvalidConnectorUrlError ||
  (error instanceof OAuthTokenError &&
    (error.status === BAD_REQUEST || error.status === UNAUTHORIZED));

const mayRefreshAhead = (
  authKind: ConnectorAuthKind,
  expiresAt: string | null,
  nowMs: number
): boolean =>
  authKind === "oauth" &&
  expiresAt !== null &&
  Date.parse(expiresAt) - nowMs <= REFRESH_AHEAD_MS;

export const createCredentialsService = ({
  clock,
  db,
  fetch: fetchImpl,
  secretsKey,
}: {
  clock: Clock;
  db: Database;
  fetch: Fetcher;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Reading a credential needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const binding = (row: CredentialRow) => ({
    field: "secret",
    rowId: row.id,
    table: "credentials",
    workspaceId: row.workspaceId,
  });

  const loadRow = async (
    id: string,
    workspaceId: string
  ): Promise<CredentialRow | null> => {
    const [row] = await db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.id, id), eq(credentials.workspaceId, workspaceId))
      )
      .limit(1);
    return row ?? null;
  };

  const loadConnector = async (
    id: string,
    workspaceId: string
  ): Promise<ConnectorRow | null> => {
    const [row] = await db
      .select()
      .from(connectors)
      .where(
        and(eq(connectors.id, id), eq(connectors.workspaceId, workspaceId))
      )
      .limit(1);
    return row ?? null;
  };

  /** The decrypted secret: a header value, or the OAuth token pair. */
  const openSecret = async (
    row: CredentialRow,
    connector: ConnectorRow
  ): Promise<{ accessToken: string; refreshToken: string | null }> => {
    const plain = await decryptSecret(
      await cryptoKey(),
      binding(row),
      row.secret
    );
    if (connector.authKind !== "oauth") {
      return { accessToken: plain, refreshToken: null };
    }
    return oauthSecretSchema.parse(JSON.parse(plain));
  };

  const toDecrypted = (
    row: CredentialRow,
    connector: ConnectorRow,
    secret: { accessToken: string }
  ): OwnedCredential => ({
    expiresAt: row.expiresAt,
    header:
      connector.authKind === "oauth"
        ? { name: DEFAULT_HEADER_NAME, value: `Bearer ${secret.accessToken}` }
        : {
            name: connector.headerName ?? DEFAULT_HEADER_NAME,
            value: secret.accessToken,
          },
    id: row.id,
    ownerId: row.ownerId,
    ownerKind: row.ownerKind,
    version: row.version,
  });

  /** The row as something to send, or why it cannot be sent. */
  const usable = async (
    row: CredentialRow,
    connector: ConnectorRow
  ): Promise<Refreshed> => {
    const owner = { id: row.ownerId, kind: row.ownerKind };
    if (row.status !== "ok") {
      return needsAuth(connector.id, owner, causeOf(row.status));
    }
    const secret = await openSecret(row, connector);
    return { credential: toDecrypted(row, connector, secret), ok: true };
  };

  /** Releases a lease this caller holds, when nothing else changed the row. */
  const releaseLease = async (row: CredentialRow, mine: string) => {
    await db
      .update(credentials)
      .set({ refreshingUntil: null })
      .where(
        and(
          eq(credentials.id, row.id),
          eq(credentials.version, row.version),
          eq(credentials.refreshingUntil, mine)
        )
      );
  };

  /** The lease holder's fenced write. Zero rows means the row moved on. */
  const fencedWrite = async (
    row: CredentialRow,
    mine: string,
    set: Partial<typeof credentials.$inferInsert>
  ): Promise<boolean> => {
    const written = await db
      .update(credentials)
      .set({
        ...set,
        refreshingUntil: null,
        updatedAt: clock.now().toISOString(),
        version: row.version + 1,
      })
      .where(
        and(
          eq(credentials.id, row.id),
          eq(credentials.version, row.version),
          eq(credentials.refreshingUntil, mine),
          ne(credentials.status, "revoked")
        )
      )
      .returning({ id: credentials.id });
    return written.length > 0;
  };

  /** Whatever the row is now, after a fenced write lost to something newer. */
  const afterStaleWrite = async (
    row: CredentialRow,
    connector: ConnectorRow
  ): Promise<Refreshed> => {
    const current = await loadRow(row.id, row.workspaceId);
    return current
      ? await usable(current, connector)
      : needsAuth(
          connector.id,
          { id: row.ownerId, kind: row.ownerKind },
          "missing"
        );
  };

  const clientCredentials = async (
    connector: ConnectorRow,
    client: NonNullable<ReturnType<typeof parseOAuthConfig>>["client"]
  ) => {
    if (!client) {
      return null;
    }
    return {
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
    };
  };

  /**
   * The lease holder's work: one call to the token endpoint and one fenced
   * write. A refusal, or nothing to refresh with, ends in `needs_auth`.
   */
  const refreshAsHolder = async (
    row: CredentialRow,
    connector: ConnectorRow,
    mine: string
  ): Promise<Refreshed> => {
    const owner = { id: row.ownerId, kind: row.ownerKind };
    const markRefused = async (): Promise<Refreshed> =>
      (await fencedWrite(row, mine, { status: "needs_auth" }))
        ? needsAuth(connector.id, owner, "needs_auth")
        : await afterStaleWrite(row, connector);

    const old = await openSecret(row, connector);
    const config =
      connector.authKind === "oauth" ? parseOAuthConfig(connector.oauth) : null;
    // The shared Google secret goes only to Google's token endpoint.
    const client =
      config && !(config.client?.source === "shared" && !onGoogle(config))
        ? await clientCredentials(connector, config.client)
        : null;
    if (!(config && client && old.refreshToken)) {
      return await markRefused();
    }

    let tokens: Awaited<ReturnType<typeof refreshTokens>>;
    try {
      tokens = await refreshTokens(
        config.tokenEndpoint,
        client,
        {
          refreshToken: old.refreshToken,
          resource: config.resource,
          scope: row.scopes ?? config.scope,
        },
        { fetchImpl, nowMs: () => clock.now().getTime() }
      );
    } catch (error: unknown) {
      if (isRefusal(error)) {
        return await markRefused();
      }
      // The provider could not be reached or had a bad moment: not a verdict.
      await releaseLease(row, mine);
      return { ok: false, reason: "retry" };
    }

    const secret = await encryptSecret(
      await cryptoKey(),
      binding(row),
      JSON.stringify({
        accessToken: tokens.accessToken,
        // A refresh that sends no new refresh token keeps the old one.
        refreshToken: tokens.refreshToken ?? old.refreshToken,
      })
    );
    const written = await fencedWrite(row, mine, {
      expiresAt: tokens.expiresAt.toISOString(),
      scopes: tokens.scope ?? row.scopes,
      secret,
    });
    return written
      ? await usable((await loadRow(row.id, row.workspaceId)) ?? row, connector)
      : await afterStaleWrite(row, connector);
  };

  /** A loser waits for the winner's new version, up to `REFRESH_WAIT_MS`. */
  const waitForNewer = async (
    row: CredentialRow,
    connector: ConnectorRow
  ): Promise<Refreshed> => {
    const attempts = Math.ceil(REFRESH_WAIT_MS / POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each poll depends on the last
      const current = await loadRow(row.id, row.workspaceId);
      if (!current) {
        break;
      }
      if (current.version !== row.version) {
        return await usable(current, connector);
      }
      await clock.sleep(POLL_MS);
    }
    return { ok: false, reason: "retry" };
  };

  /**
   * A fresh login for a credential the server refused or that is about to
   * expire. Whoever wins the lease calls the token endpoint, once.
   */
  const refresh = async (input: RefreshInput): Promise<Refreshed> => {
    const row = await loadRow(input.credentialId, input.workspaceId);
    if (!row) {
      return { ok: false, reason: "retry" };
    }
    const connector = await loadConnector(row.connectorId, row.workspaceId);
    if (!connector) {
      return { ok: false, reason: "retry" };
    }
    if (row.version !== input.seenVersion || row.status !== "ok") {
      return await usable(row, connector);
    }
    const now = clock.now();
    const mine = new Date(now.getTime() + REFRESH_LEASE_MS).toISOString();
    const taken = await db
      .update(credentials)
      .set({ refreshingUntil: mine })
      .where(
        and(
          eq(credentials.id, row.id),
          eq(credentials.version, row.version),
          eq(credentials.status, "ok"),
          or(
            isNull(credentials.refreshingUntil),
            lt(credentials.refreshingUntil, now.toISOString())
          )
        )
      )
      .returning({ id: credentials.id });
    if (taken.length === 0) {
      return input.noWait
        ? { ok: false, reason: "retry" }
        : await waitForNewer(row, connector);
    }
    try {
      return await refreshAsHolder(row, connector, mine);
    } catch (error: unknown) {
      await releaseLease(row, mine);
      throw error;
    }
  };

  /** Whether a machine is `single_user` and enrolled by someone else. */
  const isForeignSingleUser = async (input: ResolveInput): Promise<boolean> => {
    if (!(input.machineId && input.onBehalfOfUserId)) {
      return false;
    }
    const [machine] = await db
      .select({
        enrolledBy: machines.enrolledBy,
        singleUser: machines.singleUser,
      })
      .from(machines)
      .where(
        and(
          eq(machines.id, input.machineId),
          eq(machines.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    return Boolean(
      machine?.singleUser && machine.enrolledBy !== input.onBehalfOfUserId
    );
  };

  /** Whose credential the call uses, or why nobody's. */
  const chooseOwner = async (
    mode: "agent" | "user" | "user_or_agent",
    input: ResolveInput
  ): Promise<
    | { note: ResolveNote | null; ok: true; owner: Owner }
    | { cause: NeedsAuthCause; ok: false; owner: Owner }
  > => {
    const agent: Owner = { id: input.agentId, kind: "agent" };
    const person: Owner = { id: input.onBehalfOfUserId, kind: "user" };
    if (mode === "agent") {
      return { note: null, ok: true, owner: agent };
    }
    if (input.onBehalfOfUserId === null) {
      return mode === "user"
        ? { cause: "no_person", ok: false, owner: person }
        : { note: null, ok: true, owner: agent };
    }
    if (await isForeignSingleUser(input)) {
      return mode === "user"
        ? { cause: "single_user_machine", ok: false, owner: person }
        : { note: "single_user_machine", ok: true, owner: agent };
    }
    return { note: null, ok: true, owner: person };
  };

  /** The login to hand out, refreshed first when it is about to expire. */
  const refreshedAhead = async (
    row: CredentialRow,
    connector: ConnectorRow,
    current: OwnedCredential
  ): Promise<Refreshed> => {
    const nowMs = clock.now().getTime();
    if (!mayRefreshAhead(connector.authKind, row.expiresAt, nowMs)) {
      return { credential: current, ok: true };
    }
    // Without a refresh token the token is used until the server refuses it.
    if (!(await openSecret(row, connector)).refreshToken) {
      return { credential: current, ok: true };
    }
    const refreshed = await refresh({
      credentialId: row.id,
      noWait: true,
      seenVersion: row.version,
      workspaceId: row.workspaceId,
    });
    if (refreshed.ok || refreshed.reason === "needs_auth") {
      return refreshed;
    }
    // Someone else is refreshing. The token still works until it expires.
    const expired = Date.parse(row.expiresAt ?? "") <= clock.now().getTime();
    return expired
      ? { ok: false, reason: "retry" }
      : { credential: current, ok: true };
  };

  const connectorSummary = (connector: ConnectorRow) => ({
    callTimeoutSeconds: connector.callTimeoutSeconds,
    id: connector.id,
    name: connector.name,
    url: connector.url,
  });

  /** A connector with no auth: nothing to look up, nothing to refresh. */
  const openConnectorResolution = (
    connector: ConnectorRow,
    allowedTools: string[] | null
  ): Resolution => ({
    allowedTools,
    connector: connectorSummary(connector),
    credential: null,
    note: null,
    ok: true,
    ownerKind: null,
    version: null,
  });

  const resolveSecret = async (
    connector: ConnectorRow,
    allowedTools: string[] | null
  ): Promise<Resolution> => {
    const secret = await readConnectorSecret(db, await cryptoKey(), connector);
    return {
      allowedTools,
      connector: connectorSummary(connector),
      credential: {
        expiresAt: null,
        header: secret.header,
        id: null,
        ownerId: connector.workspaceId,
        ownerKind: "workspace",
        version: secret.version,
      },
      note: null,
      ok: true,
      ownerKind: "workspace",
      version: secret.version,
    };
  };

  /** Once the owner is chosen: their stored login, usable and refreshed. */
  const resolveOwned = async (
    connector: ConnectorRow,
    owner: Owner,
    extra: { allowedTools: string[] | null; note: ResolveNote | null }
  ): Promise<Resolution> => {
    const [row] =
      owner.id === null
        ? []
        : await db
            .select()
            .from(credentials)
            .where(
              and(
                eq(credentials.connectorId, connector.id),
                eq(credentials.ownerKind, owner.kind),
                eq(credentials.ownerId, owner.id),
                eq(credentials.workspaceId, connector.workspaceId)
              )
            )
            .limit(1);
    if (!row) {
      return needsAuth(connector.id, owner, "missing");
    }
    const current = await usable(row, connector);
    if (!current.ok) {
      return current;
    }
    const ready = await refreshedAhead(row, connector, current.credential);
    return ready.ok
      ? {
          allowedTools: extra.allowedTools,
          connector: connectorSummary(connector),
          credential: ready.credential,
          note: extra.note,
          ok: true,
          ownerKind: ready.credential.ownerKind,
          version: ready.credential.version,
        }
      : ready;
  };

  const resolve = async (input: ResolveInput): Promise<Resolution> => {
    const { agentId, connectorId, workspaceId } = input;
    const scope = input.runId
      ? await effectiveRunScope(db, workspaceId, input.runId)
      : null;
    if (!scopeAllows(scope, "connectors", connectorId)) {
      return { ok: false, reason: "not_assigned" };
    }
    const [link] = await db
      .select({
        allowedTools: agentConnectors.allowedTools,
        connector: connectors,
        mode: agentConnectors.credentialMode,
      })
      .from(agentConnectors)
      .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
      .where(
        and(
          eq(agentConnectors.agentId, agentId),
          eq(agentConnectors.connectorId, connectorId),
          eq(agentConnectors.workspaceId, workspaceId),
          eq(connectors.workspaceId, workspaceId)
        )
      )
      .limit(1);
    if (!link) {
      return { ok: false, reason: "not_assigned" };
    }
    const { connector } = link;
    const allowedTools = scopedTools(
      scope,
      decodeAllowedTools(link.allowedTools)
    );
    if (connector.authKind === "none") {
      return openConnectorResolution(connector, allowedTools);
    }

    if (
      connector.authKind === "header" &&
      (connector.secretId || connector.headerTemplate)
    ) {
      return await resolveSecret(connector, allowedTools);
    }
    const chosen = await chooseOwner(link.mode, input);
    if (!chosen.ok) {
      return needsAuth(connector.id, chosen.owner, chosen.cause);
    }
    return await resolveOwned(connector, chosen.owner, {
      allowedTools,
      note: chosen.note,
    });
  };

  /** The viewer's own login, with no agent in play and no fallback to one. */
  const resolveUser = async (input: {
    connectorId: string;
    userId: string;
    workspaceId: string;
  }): Promise<Resolution> => {
    const connector = await loadConnector(input.connectorId, input.workspaceId);
    if (!connector) {
      return { ok: false, reason: "not_assigned" };
    }
    if (connector.authKind === "none") {
      return openConnectorResolution(connector, null);
    }
    if (
      connector.authKind === "header" &&
      (connector.secretId || connector.headerTemplate)
    ) {
      return await resolveSecret(connector, null);
    }
    return await resolveOwned(
      connector,
      { id: input.userId, kind: "user" },
      { allowedTools: null, note: null }
    );
  };

  /** What the run row says about whom the run is for and where it runs. */
  const runContext = async (run: {
    runId: string;
    workspaceId: string;
  }): Promise<{
    machineId: string | null;
    onBehalfOfUserId: string | null;
    sessionId: string;
  } | null> => {
    const [row] = await db
      .select({
        machineId: runs.claimedBy,
        onBehalfOfUserId: runs.onBehalfOfUserId,
        sessionId: runs.sessionId,
      })
      .from(runs)
      .where(
        and(
          eq(runs.id, run.runId),
          eq(runs.workspaceId, run.workspaceId),
          isNull(runs.scopeArtifactId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  return { refresh, resolve, resolveUser, runContext };
};

export type CredentialsService = ReturnType<typeof createCredentialsService>;
