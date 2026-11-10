/**
 * The registry of remote MCP servers ("connectors"), the header credentials
 * pasted for them, and the assignment of connectors to agents.
 *
 * A connector is added by URL. The URL goes through the SSRF guard
 * (`connectors/safe-url.ts`), then a probe (`initialize` and `tools/list`)
 * tells us whether the server wants no auth, a pasted header, or OAuth, and
 * caches its tool list. A header credential is pasted as the calling user or
 * as an agent. Both can exist for one connector, one row per owner.
 *
 * The pasted value is encrypted with `encryptSecret`, bound to its row. It is
 * never read back: every query here selects `credentialColumns`, which has no
 * `secret`, so no return value, event or error can carry it. The proxy that
 * decrypts it is M3.3.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  agentConnectors,
  connectors,
  credentials,
  oauthStates,
} from "@repo/db/schema/connectors";
import { runs } from "@repo/db/schema/runs";
import { secrets } from "@repo/db/schema/secrets";
import {
  CONNECTOR_AUTH_MODES,
  CONNECTOR_CALL_TIMEOUT_SECONDS,
  type ConnectorAuthKind,
  type ConnectorAuthMode,
  type ConnectorStatus,
  CREDENTIAL_MODES,
  type CredentialMode,
  type CredentialOwnerKind,
  type CredentialStatus,
  LIVE_RUN_STATUSES,
} from "@repo/db/shared";
import { createMasker } from "@repo/protocol/masker";
import { and, asc, eq, inArray, notExists, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { requireAgentManager, requireKey } from "./admin-access.ts";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  decodeAllowedTools,
  encodeAllowedTools,
} from "./connectors/allowed-tools.ts";
import {
  findCredentialSlot,
  writeCredential,
} from "./connectors/credential-write.ts";
import {
  type CachedTool,
  type Fetcher,
  McpError,
  McpUnauthorizedError,
  probeMcpServer,
} from "./connectors/mcp.ts";
import {
  discoverAuthorization,
  OAuthDiscoveryError,
  scopeFor,
} from "./connectors/oauth.ts";
import {
  configFromDiscovery,
  type OAuthConfig,
  parseOAuthConfig,
  type SharedGoogleClient,
  sharedClientApplies,
} from "./connectors/oauth-config.ts";
import { readConnectorSecret } from "./connectors/secret.ts";
import { toolSchema } from "./connectors/tool-schema.ts";
import {
  canonicalizeConnectorUrl,
  InvalidConnectorUrlError,
} from "./connectors/url.ts";
import { encryptSecret, importSecretsKey } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { ruleSchema } from "./secrets/rules.ts";
import type { Principal } from "./workspaces.ts";

const CONNECTOR_KIND = "connector";
const CREATE_ACTION = "connectors.create";
const LIST_ACTION = "connectors.list";
const SET_CREDENTIAL_ACTION = "connectors.setCredential";
const SET_AUTH_MODE_ACTION = "connectors.setAuthMode";
const SET_CALL_TIMEOUT_ACTION = "connectors.setCallTimeout";
const ASSIGN_ACTION = "connectors.assign";
const UNASSIGN_ACTION = "connectors.unassign";
const DELETE_ACTION = "connectors.delete";
const ASSIGNMENTS_ACTION = "connectors.assignments";

const DEFAULT_HEADER_NAME = "Authorization";
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
/** Visible ASCII and spaces: a header value cannot carry control characters. */
const HEADER_VALUE_PATTERN = /^[ -~]+$/;
/** Headers the MCP client sets itself. A connector cannot override them. */
const RESERVED_HEADERS = new Set([
  "accept",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

type UserPrincipal = Extract<Principal, { kind: "user" }>;

const idString = z.string().min(1).max(200);

const headerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(HEADER_NAME_PATTERN, "A header name uses letters, digits and dashes.")
  .refine(
    (name) => !RESERVED_HEADERS.has(name.toLowerCase()),
    "That header is set by the MCP client."
  );

const headerTemplateSchema = ruleSchema.shape.template.refine(
  (text) => text.split("{value}").length === 2,
  "The header template must contain {value} exactly once."
);

export const connectorCreateSchema = z.strictObject({
  authMode: z.enum(CONNECTOR_AUTH_MODES).default("auto"),
  headerName: headerNameSchema.optional(),
  headerTemplate: headerTemplateSchema.optional(),
  name: z.string().trim().min(1).max(80),
  secretId: idString.nullable().optional(),
  url: z.string().trim().min(1).max(2048),
});
export type ConnectorCreateInput = z.input<typeof connectorCreateSchema>;

/** `agentId` set pastes the value as that agent, left out pastes it as the caller. */
export const credentialSetSchema = z.strictObject({
  agentId: idString.optional(),
  connectorId: idString,
  value: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(HEADER_VALUE_PATTERN, "A header value is plain text on one line."),
});
export type CredentialSetInput = z.input<typeof credentialSetSchema>;

export const connectorAuthModeSchema = z.strictObject({
  authMode: z.enum(CONNECTOR_AUTH_MODES),
  connectorId: idString,
  headerName: headerNameSchema.optional(),
  headerTemplate: headerTemplateSchema.optional(),
  secretId: idString.nullable().optional(),
});
export type ConnectorAuthModeInput = z.input<typeof connectorAuthModeSchema>;

export const connectorCallTimeoutSchema = z.strictObject({
  connectorId: idString,
  seconds: z
    .int()
    .min(CONNECTOR_CALL_TIMEOUT_SECONDS.min)
    .max(CONNECTOR_CALL_TIMEOUT_SECONDS.max),
});
export type ConnectorCallTimeoutInput = z.input<
  typeof connectorCallTimeoutSchema
>;

export const assignmentInputSchema = z.strictObject({
  agentId: idString,
  allowedTools: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  connectorId: idString,
  credentialMode: z.enum(CREDENTIAL_MODES).default("user_or_agent"),
});
export type AssignmentInput = z.input<typeof assignmentInputSchema>;

export const unassignInputSchema = z.strictObject({
  agentId: idString,
  connectorId: idString,
});

export const removeInputSchema = z.strictObject({ connectorId: idString });

export const agentInputSchema = z.strictObject({ agentId: idString });

export interface CredentialSummary {
  createdAt: string;
  id: string;
  ownerId: string;
  ownerKind: CredentialOwnerKind;
  status: CredentialStatus;
  updatedAt: string;
  version: number;
}

export interface ConnectorSummary {
  /** Every agent-owned credential of this connector. */
  agentCredentials: CredentialSummary[];
  authKind: ConnectorAuthKind;
  /** The person's choice. Anything but `auto` is never changed by a probe. */
  authMode: ConnectorAuthMode;
  /** Seconds a tool call may take before it is stopped. */
  callTimeoutSeconds: number;
  createdAt: string;
  headerName: string | null;
  headerTemplate: string | null;
  id: string;
  /** The calling user's own credential, if they pasted one. */
  myCredential: CredentialSummary | null;
  name: string;
  /** For an OAuth connector: whether Connect can run now. Never the client itself. */
  oauth: { canRegister: boolean; clientConfigured: boolean } | null;
  secretId: string | null;
  secretName: string | null;
  status: ConnectorStatus;
  tools: CachedTool[];
  toolsFetchedAt: string | null;
  url: string;
}

export interface AssignmentSummary {
  agentId: string;
  /** Tool names the agent may use through this connector, null for every tool. */
  allowedTools: string[] | null;
  connectorId: string;
  createdAt: string;
  credentialMode: CredentialMode;
}

/** Everything about a credential except the secret. Never select `secret`. */
const credentialColumns = {
  connectorId: credentials.connectorId,
  createdAt: credentials.createdAt,
  id: credentials.id,
  ownerId: credentials.ownerId,
  ownerKind: credentials.ownerKind,
  status: credentials.status,
  updatedAt: credentials.updatedAt,
  version: credentials.version,
};

type ConnectorRow = typeof connectors.$inferSelect;
type CredentialRow = Pick<
  typeof credentials.$inferSelect,
  keyof typeof credentialColumns
>;

const toCredentialSummary = (row: CredentialRow): CredentialSummary => ({
  createdAt: row.createdAt,
  id: row.id,
  ownerId: row.ownerId,
  ownerKind: row.ownerKind,
  status: row.status,
  updatedAt: row.updatedAt,
  version: row.version,
});

const oauthSummary = (
  row: ConnectorRow,
  shared: SharedGoogleClient | undefined
): ConnectorSummary["oauth"] => {
  const config = row.authKind === "oauth" ? parseOAuthConfig(row.oauth) : null;
  return config
    ? {
        // The shared Google client counts as a way to get a client with no dialog.
        canRegister:
          config.registrationEndpoint !== null ||
          sharedClientApplies(config, row.url, shared),
        // A shared client only counts while the deployment still has one.
        clientConfigured:
          config.client !== null &&
          !(config.client.source === "shared" && shared === undefined),
      }
    : null;
};

const toSummary = (
  row: ConnectorRow,
  owned: readonly CredentialRow[],
  userId: string,
  shared: SharedGoogleClient | undefined
): ConnectorSummary => {
  const mine = owned.find(
    (credential) =>
      credential.ownerKind === "user" && credential.ownerId === userId
  );
  return {
    agentCredentials: owned
      .filter((credential) => credential.ownerKind === "agent")
      .map(toCredentialSummary),
    authKind: row.authKind,
    authMode: row.authMode,
    callTimeoutSeconds: row.callTimeoutSeconds,
    createdAt: row.createdAt,
    headerName: row.headerName,
    headerTemplate: row.headerTemplate,
    id: row.id,
    myCredential: mine ? toCredentialSummary(mine) : null,
    name: row.name,
    oauth: oauthSummary(row, shared),
    secretId: row.secretId,
    secretName: null,
    status: row.status,
    tools: toolSchema.parse(JSON.parse(row.tools)),
    toolsFetchedAt: row.toolsFetchedAt,
    url: row.url,
  };
};

const invalid = (message: string): ServiceError =>
  new ServiceError("invalid", message);

/** Safe guidance for callers that cannot grant access to a workspace secret. */
export class ConnectorSecretAdminError extends ForbiddenError {
  constructor() {
    super("connectors.linkSecret");
    this.message = "An admin must do this in the app.";
  }
}

/** Keys and connectors are managed from a signed-in session. */
export const requireUser = (
  principal: Principal,
  action: string
): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** Assigning connectors also admits write OAuth connections and write/admin keys (MA.1). The registry and credentials stay with a session. */
const requireAssigner = (
  principal: Principal,
  action: string
): UserPrincipal => {
  if (principal.kind === "user" && principal.via !== "session") {
    return requireAgentManager(principal, action);
  }
  return requireUser(principal, action);
};

type ProbeOutcome =
  | { kind: "ok"; tools: CachedTool[] }
  | { kind: "unauthorized"; wwwAuthenticate: string | null };

export const loadConnector = async (
  db: Database,
  connectorId: string,
  workspaceId: string
): Promise<ConnectorRow> => {
  const [row] = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.id, connectorId),
        eq(connectors.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!row) {
    throw new ServiceError("not_found", "Connector not found");
  }
  return row;
};

export const loadActiveAgent = async (
  db: Database,
  agentId: string,
  workspaceId: string
) => {
  const agent = await findAgent(db, { id: agentId, workspaceId });
  if (!agent) {
    throw new ServiceError("not_found", "Agent not found");
  }
  if (agent.status !== "active") {
    throw new ServiceError("invalid", "That agent is not active");
  }
  return agent;
};

export const createConnectorsService = ({
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
  /** The deployment's Google OAuth client; only its presence shows in a summary. */
  sharedGoogleClient?: SharedGoogleClient;
  /** `SECRETS_KEY`, base64. Stores credentials and probes linked workspace secrets. */
  secretsKey?: string;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const cryptoKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Storing a credential needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const secretNames = async (
    rows: readonly ConnectorRow[],
    workspaceId: string
  ) => {
    const ids = rows.flatMap((row) => (row.secretId ? [row.secretId] : []));
    if (ids.length === 0) {
      return new Map<string, string>();
    }
    const names = await db
      .select({ id: secrets.id, name: secrets.name })
      .from(secrets)
      .where(
        and(eq(secrets.workspaceId, workspaceId), inArray(secrets.id, ids))
      );
    return new Map(names.map((secret) => [secret.id, secret.name]));
  };

  const summarize = async (
    row: ConnectorRow,
    owned: readonly CredentialRow[],
    userId: string,
    names?: ReadonlyMap<string, string>
  ): Promise<ConnectorSummary> => {
    const summary = toSummary(row, owned, userId, sharedGoogleClient);
    const loaded = names ?? (await secretNames([row], row.workspaceId));
    summary.secretName = row.secretId
      ? (loaded.get(row.secretId) ?? null)
      : null;
    return summary;
  };

  const requireSecretAdmin = (principal: Principal) => {
    if (
      principal.kind !== "user" ||
      principal.via !== "session" ||
      !principal.isAdmin
    ) {
      throw new ConnectorSecretAdminError();
    }
  };

  const secretFields = (
    user: UserPrincipal,
    parsed: {
      authMode: ConnectorAuthMode;
      secretId?: string | null;
      headerTemplate?: string;
      headerName?: string;
    },
    current?: ConnectorRow
  ) => {
    const clearsLink =
      (current?.secretId || current?.headerTemplate) &&
      parsed.authMode !== "header";
    const changesHeader =
      current?.secretId &&
      ["headerName", "headerTemplate"].some((field) => {
        const key = field as "headerName" | "headerTemplate";
        return parsed[key] !== undefined && parsed[key] !== current[key];
      });
    if (parsed.secretId !== undefined || clearsLink || changesHeader) {
      requireSecretAdmin(user);
    }
    let secretId = current?.secretId ?? null;
    if (parsed.secretId !== undefined) {
      ({ secretId } = parsed);
    }
    if (parsed.authMode !== "header") {
      if (parsed.secretId) {
        throw invalid(
          "A workspace secret needs API key header authentication."
        );
      }
      return { headerTemplate: null, secretId: null };
    }
    const needsSecret =
      secretId || (parsed.secretId === undefined && current?.headerTemplate);
    return {
      headerTemplate: needsSecret
        ? (parsed.headerTemplate ?? current?.headerTemplate ?? "Bearer {value}")
        : null,
      secretId,
    };
  };

  /**
   * One round trip to the server. A 401 or 403 is an outcome, not an error.
   * Anything else that goes wrong is a refusal written for the user, with
   * `redact` (a pasted secret) scrubbed from the server's own words.
   */
  const probe = async (
    url: string,
    header?: { name: string; value: string; redact?: string }
  ): Promise<ProbeOutcome> => {
    try {
      const result = await probeMcpServer(url, { fetchImpl, header });
      const tools = header?.redact
        ? createMasker({ connector: header.redact }).maskDeep(result.tools)
        : result.tools;
      return { kind: "ok", tools };
    } catch (error: unknown) {
      if (error instanceof McpUnauthorizedError) {
        return { kind: "unauthorized", wwwAuthenticate: error.wwwAuthenticate };
      }
      const detail = error instanceof McpError ? ` ${error.message}` : "";
      const message = `Could not read the tool list from that server.${detail}`;
      throw invalid(
        header
          ? message
              .replaceAll(header.value, "[redacted]")
              .replaceAll(header.redact ?? header.value, "[redacted]")
          : message
      );
    }
  };

  /**
   * The OAuth server a 401 points at, found through the server's own metadata
   * (RFC 9728, then RFC 8414). Null when it publishes none, which makes the
   * connector a header connector.
   */
  const discoverOAuth = async (
    url: string,
    wwwAuthenticate: string | null
  ): Promise<OAuthConfig | null> => {
    try {
      const found = await discoverAuthorization(url, wwwAuthenticate, {
        fetchImpl,
      });
      return configFromDiscovery(
        found,
        url,
        scopeFor(found.resource, found.metadata)
      );
    } catch (error: unknown) {
      if (error instanceof OAuthDiscoveryError) {
        return null;
      }
      throw error;
    }
  };

  /**
   * Decides how a connector authenticates. `auto` follows the unauthenticated
   * probe: a 401 means OAuth when the server publishes metadata, a header
   * otherwise. `oauth` runs the same discovery without needing the 401, so a
   * server that answers anyone still gets a login. `none` never starts OAuth.
   * `header` forces a header and skips OAuth discovery.
   * `tools` is the list the probe read, null when the server asked for auth.
   */
  const resolveAuth = async (
    url: string,
    mode: ConnectorAuthMode
  ): Promise<{
    authKind: ConnectorAuthKind;
    oauth: OAuthConfig | null;
    status: ConnectorStatus;
    tools: CachedTool[] | null;
  }> => {
    const outcome = await probe(url);
    const tools = outcome.kind === "ok" ? outcome.tools : null;
    if (mode === "header") {
      return { authKind: "header", oauth: null, status: "needs_auth", tools };
    }
    if (mode === "none" || (mode === "auto" && outcome.kind === "ok")) {
      return { authKind: "none", oauth: null, status: "ok", tools };
    }
    const oauth = await discoverOAuth(
      url,
      outcome.kind === "unauthorized" ? outcome.wwwAuthenticate : null
    );
    if (mode === "oauth") {
      if (!oauth) {
        throw invalid(
          "That server does not publish OAuth metadata, so it cannot be set to OAuth. Use a header or no authentication instead."
        );
      }
      return { authKind: "oauth", oauth, status: "needs_auth", tools };
    }
    // Auto, and the server asked for auth.
    return {
      authKind: oauth ? "oauth" : "header",
      oauth,
      status: "needs_auth",
      tools: null,
    };
  };

  const credentialsOf = async (
    workspaceId: string,
    userId: string,
    connectorId?: string
  ): Promise<CredentialRow[]> =>
    await db
      .select(credentialColumns)
      .from(credentials)
      .where(
        and(
          eq(credentials.workspaceId, workspaceId),
          connectorId === undefined
            ? undefined
            : eq(credentials.connectorId, connectorId),
          // Another user's own credential is theirs alone.
          or(
            eq(credentials.ownerKind, "agent"),
            and(
              eq(credentials.ownerKind, "user"),
              eq(credentials.ownerId, userId)
            )
          )
        )
      )
      .orderBy(asc(credentials.createdAt), asc(credentials.id));

  const probeLinked = async (
    workspaceId: string,
    url: string,
    headerName: string | undefined | null,
    linked: { secretId: string | null; headerTemplate: string | null },
    found: Awaited<ReturnType<typeof resolveAuth>>
  ): Promise<Awaited<ReturnType<typeof resolveAuth>>> => {
    if (!linked.secretId) {
      return found;
    }
    const secret = await readConnectorSecret(
      db,
      await cryptoKey(),
      {
        ...linked,
        headerName: headerName ?? DEFAULT_HEADER_NAME,
        url,
        workspaceId,
      },
      true
    );
    const outcome = await probe(url, secret.header);
    if (outcome.kind !== "ok") {
      throw invalid(
        "The server refused the connector's secret. Check the header and value in Settings, Secrets."
      );
    }
    return { ...found, status: "ok" as const, tools: outcome.tools };
  };

  /** Adds a connector by URL: guard, probe, then store what the probe found. */
  const create = async (
    principal: Principal,
    input: ConnectorCreateInput
  ): Promise<ConnectorSummary> => {
    const user = requireUser(principal, CREATE_ACTION);
    const parsed = connectorCreateSchema.parse(input);
    authorize(user, CREATE_ACTION, {
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    let url: string;
    try {
      url = canonicalizeConnectorUrl(parsed.url);
    } catch (error: unknown) {
      if (error instanceof InvalidConnectorUrlError) {
        throw invalid(error.message);
      }
      throw error;
    }

    const linked = secretFields(user, parsed);
    const now = clock.now();
    const found = await probeLinked(
      user.workspaceId,
      url,
      parsed.headerName,
      linked,
      await resolveAuth(url, parsed.authMode)
    );
    const row: ConnectorRow = {
      authKind: found.authKind,
      authMode: parsed.authMode,
      callTimeoutSeconds: CONNECTOR_CALL_TIMEOUT_SECONDS.default,
      createdAt: now.toISOString(),
      createdBy: user.userId,
      headerName:
        found.authKind === "header"
          ? (parsed.headerName ?? DEFAULT_HEADER_NAME)
          : null,
      ...linked,
      id: ulid(now.getTime()),
      name: parsed.name,
      oauth: found.oauth ? JSON.stringify(found.oauth) : null,
      status: linked.secretId ? "ok" : found.status,
      tools: JSON.stringify(found.tools ?? []),
      toolsFetchedAt: found.tools ? now.toISOString() : null,
      url,
      workspaceId: user.workspaceId,
    };
    await db.insert(connectors).values(row);
    return await summarize(row, [], user.userId);
  };

  /** The workspace's connectors with the credentials the caller may see. */
  const list = async (principal: Principal): Promise<ConnectorSummary[]> => {
    const user = requireUser(principal, LIST_ACTION);
    authorize(user, LIST_ACTION, {
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    const rows = await db
      .select()
      .from(connectors)
      .where(eq(connectors.workspaceId, user.workspaceId))
      .orderBy(asc(connectors.createdAt), asc(connectors.id));
    const owned = await credentialsOf(user.workspaceId, user.userId);
    const names = await secretNames(rows, user.workspaceId);
    return await Promise.all(
      rows.map((row) =>
        summarize(
          row,
          owned.filter((credential) => credential.connectorId === row.id),
          user.userId,
          names
        )
      )
    );
  };

  /**
   * Pastes a header value for a connector, as the caller or as an agent. The
   * value is tried against the server first, so a wrong one is refused and
   * nothing is stored. Pasting again for the same owner replaces the value and
   * bumps `version`. A good probe also refreshes the connector's tool list.
   */
  const setCredential = async (
    principal: Principal,
    input: CredentialSetInput
  ): Promise<CredentialSummary> => {
    const user = requireUser(principal, SET_CREDENTIAL_ACTION);
    const parsed = credentialSetSchema.parse(input);
    const { workspaceId } = user;
    authorize(user, SET_CREDENTIAL_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId,
    });
    const connector = await loadConnector(db, parsed.connectorId, workspaceId);
    if (connector.authKind !== "header") {
      throw new ServiceError(
        "invalid",
        "Only a connector that takes a header accepts a pasted value"
      );
    }
    if (connector.secretId || connector.headerTemplate) {
      throw invalid(
        "This connector uses a workspace secret. Ask an admin to change it in Settings, Connectors."
      );
    }
    const owner: { id: string; kind: CredentialOwnerKind } = parsed.agentId
      ? {
          id: (await loadActiveAgent(db, parsed.agentId, workspaceId)).id,
          kind: "agent",
        }
      : { id: user.userId, kind: "user" };

    // Before the value leaves for the server: a missing key fails here.
    const key = await cryptoKey();
    const nowDate = clock.now();
    const now = nowDate.toISOString();
    const outcome = await probe(connector.url, {
      name: connector.headerName ?? DEFAULT_HEADER_NAME,
      value: parsed.value,
    });
    if (outcome.kind === "unauthorized") {
      throw new ServiceError("invalid", "The server rejected that value");
    }

    const slot = await findCredentialSlot(
      db,
      connector.id,
      owner,
      nowDate.getTime()
    );
    const secret = await encryptSecret(
      key,
      { field: "secret", rowId: slot.id, table: "credentials", workspaceId },
      parsed.value
    );
    await writeCredential(
      { atomic, db },
      {
        alongside: db
          .update(connectors)
          .set({
            status: "ok",
            tools: JSON.stringify(outcome.tools),
            toolsFetchedAt: now,
          })
          .where(eq(connectors.id, connector.id)),
        connectorId: connector.id,
        createdBy: user.userId,
        expiresAt: null,
        now,
        owner,
        scopes: null,
        secret,
        slot,
        workspaceId,
      }
    );
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: owner.kind === "agent" ? owner.id : null,
      payload: {
        connectorId: connector.id,
        ownerId: owner.id,
        ownerKind: owner.kind,
        replaced: slot.version !== null,
      },
      type: "credential.created",
      workspaceId,
    });
    const [saved] = await db
      .select(credentialColumns)
      .from(credentials)
      .where(eq(credentials.id, slot.id))
      .limit(1);
    if (!saved) {
      throw new ServiceError("not_found", "Credential not found");
    }
    return toCredentialSummary(saved);
  };

  /**
   * Changes how a connector authenticates. The server is probed again, so a
   * wrong choice is refused and nothing is saved. A kind that changes drops the
   * stored logins, which the new kind could not read. A connector that stays
   * OAuth keeps its discovered endpoints and client.
   */
  const setAuthMode = async (
    principal: Principal,
    input: ConnectorAuthModeInput
  ): Promise<ConnectorSummary> => {
    const user = requireUser(principal, SET_AUTH_MODE_ACTION);
    const parsed = connectorAuthModeSchema.parse(input);
    const { workspaceId } = user;
    authorize(user, SET_AUTH_MODE_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId,
    });
    const connector = await loadConnector(db, parsed.connectorId, workspaceId);
    const linked = secretFields(user, parsed, connector);
    const found = await probeLinked(
      workspaceId,
      connector.url,
      parsed.headerName ?? connector.headerName,
      linked,
      await resolveAuth(connector.url, parsed.authMode)
    );
    const kept = found.authKind === connector.authKind;
    const keepsLogin = kept && found.authKind !== "none";
    const status = keepsLogin ? connector.status : found.status;
    const now = clock.now().toISOString();
    const where = and(
      eq(connectors.id, connector.id),
      eq(connectors.workspaceId, workspaceId)
    );
    await atomic([
      ...(kept
        ? []
        : [
            db
              .delete(oauthStates)
              .where(eq(oauthStates.connectorId, connector.id)),
            db
              .delete(credentials)
              .where(eq(credentials.connectorId, connector.id)),
          ]),
      db
        .update(connectors)
        .set({
          authKind: found.authKind,
          authMode: parsed.authMode,
          headerName:
            found.authKind === "header"
              ? (parsed.headerName ??
                connector.headerName ??
                DEFAULT_HEADER_NAME)
              : null,
          ...linked,
          oauth:
            found.authKind === "oauth" && kept
              ? connector.oauth
              : found.oauth && JSON.stringify(found.oauth),
          status: linked.secretId ? "ok" : status,
          ...(found.tools
            ? { tools: JSON.stringify(found.tools), toolsFetchedAt: now }
            : {}),
        })
        .where(where),
    ]);
    const row = await loadConnector(db, connector.id, workspaceId);
    const owned = await credentialsOf(workspaceId, user.userId, row.id);
    return await summarize(row, owned, user.userId);
  };

  /** Sets how long one tool call of a connector may run. */
  const setCallTimeout = async (
    principal: Principal,
    input: ConnectorCallTimeoutInput
  ): Promise<ConnectorSummary> => {
    const user = requireUser(principal, SET_CALL_TIMEOUT_ACTION);
    const parsed = connectorCallTimeoutSchema.parse(input);
    const { workspaceId } = user;
    authorize(user, SET_CALL_TIMEOUT_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId,
    });
    await loadConnector(db, parsed.connectorId, workspaceId);
    await db
      .update(connectors)
      .set({ callTimeoutSeconds: parsed.seconds })
      .where(
        and(
          eq(connectors.id, parsed.connectorId),
          eq(connectors.workspaceId, workspaceId)
        )
      );
    const row = await loadConnector(db, parsed.connectorId, workspaceId);
    const owned = await credentialsOf(workspaceId, user.userId, row.id);
    return await summarize(row, owned, user.userId);
  };

  /** Gives an agent a connector, or changes how its credential is chosen. */
  const assign = async (
    principal: Principal,
    input: AssignmentInput
  ): Promise<AssignmentSummary> => {
    if (principal.kind === "system") {
      throw new ForbiddenError(ASSIGN_ACTION);
    }
    const parsed = assignmentInputSchema.parse(input);
    const connector = await loadConnector(
      db,
      parsed.connectorId,
      principal.workspaceId
    );
    if (connector.secretId || connector.headerTemplate) {
      requireSecretAdmin(principal);
    }
    const user = requireAssigner(principal, ASSIGN_ACTION);
    const { workspaceId } = user;
    authorize(user, ASSIGN_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId,
    });
    await loadActiveAgent(db, parsed.agentId, workspaceId);
    const createdAt = clock.now().toISOString();
    await db
      .insert(agentConnectors)
      .values({
        agentId: parsed.agentId,
        allowedTools: encodeAllowedTools(parsed.allowedTools),
        connectorId: parsed.connectorId,
        createdAt,
        credentialMode: parsed.credentialMode,
        workspaceId,
      })
      .onConflictDoUpdate({
        set: {
          credentialMode: parsed.credentialMode,
          ...(parsed.allowedTools === undefined
            ? {}
            : { allowedTools: encodeAllowedTools(parsed.allowedTools) }),
        },
        target: [agentConnectors.agentId, agentConnectors.connectorId],
      });
    const [row] = await db
      .select({
        agentId: agentConnectors.agentId,
        allowedTools: agentConnectors.allowedTools,
        connectorId: agentConnectors.connectorId,
        createdAt: agentConnectors.createdAt,
        credentialMode: agentConnectors.credentialMode,
      })
      .from(agentConnectors)
      .where(
        and(
          eq(agentConnectors.agentId, parsed.agentId),
          eq(agentConnectors.connectorId, parsed.connectorId)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Assignment not found");
    }
    return { ...row, allowedTools: decodeAllowedTools(row.allowedTools) };
  };

  /** Takes a connector away from an agent. Its credentials stay. */
  const unassign = async (
    principal: Principal,
    input: z.input<typeof unassignInputSchema>
  ): Promise<{ removed: boolean }> => {
    const user = requireUser(principal, UNASSIGN_ACTION);
    const parsed = unassignInputSchema.parse(input);
    authorize(user, UNASSIGN_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    const removed = await db
      .delete(agentConnectors)
      .where(
        and(
          eq(agentConnectors.agentId, parsed.agentId),
          eq(agentConnectors.connectorId, parsed.connectorId),
          eq(agentConnectors.workspaceId, user.workspaceId)
        )
      )
      .returning({ agentId: agentConnectors.agentId });
    return { removed: removed.length > 0 };
  };

  /**
   * Deletes a connector with its stored credentials, its OAuth sign-ins in
   * flight and its assignments to agents. A session or an admin key may do it.
   */
  const remove = async (
    principal: Principal,
    input: z.input<typeof removeInputSchema>
  ): Promise<void> => {
    const user =
      principal.kind === "user" && principal.via === "api_key"
        ? requireKey(principal, DELETE_ACTION, "admin")
        : requireUser(principal, DELETE_ACTION);
    const parsed = removeInputSchema.parse(input);
    authorize(user, DELETE_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    const connector = await loadConnector(
      db,
      parsed.connectorId,
      user.workspaceId
    );
    // The check and the delete run as one batch: each delete also requires that
    // no run is live, so a run that starts in between stops the delete.
    // Read once: the batch deletes the assignments, which its own guards must not see.
    const carriers = await db
      .select({ agentId: agentConnectors.agentId })
      .from(agentConnectors)
      .where(eq(agentConnectors.connectorId, connector.id));
    const liveRuns = () =>
      db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            inArray(
              runs.agentId,
              carriers.map((row) => row.agentId)
            ),
            inArray(runs.status, [...LIVE_RUN_STATUSES])
          )
        );
    const [live] = await liveRuns().limit(1);
    if (live) {
      throw new ServiceError(
        "conflict",
        `A run is using ${connector.name}. Delete it when the run has finished, or cancel the run first.`
      );
    }
    const idle = notExists(liveRuns());
    await atomic([
      db
        .delete(oauthStates)
        .where(and(eq(oauthStates.connectorId, connector.id), idle)),
      db
        .delete(credentials)
        .where(and(eq(credentials.connectorId, connector.id), idle)),
      db
        .delete(agentConnectors)
        .where(and(eq(agentConnectors.connectorId, connector.id), idle)),
      db.delete(connectors).where(and(eq(connectors.id, connector.id), idle)),
    ]);
    const [left] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.id, connector.id))
      .limit(1);
    if (left) {
      throw new ServiceError(
        "conflict",
        `A run started using ${connector.name}. Try again when it has finished.`
      );
    }
    // Written once the delete is known to have happened, so a stopped delete leaves no event.
    await atomic([
      events.insertStatement({
        actor: { id: user.userId, kind: "user" },
        payload: { connectorId: connector.id, name: connector.name },
        type: "connector.deleted",
        workspaceId: user.workspaceId,
      }),
    ]);
  };

  /** Throws not_found unless every id is a connector of the caller's workspace. */
  const assertExist = async (
    principal: Principal,
    connectorIds: readonly string[]
  ): Promise<void> => {
    const user = requireAssigner(principal, ASSIGN_ACTION);
    for (const connectorId of connectorIds) {
      // biome-ignore lint/performance/noAwaitInLoops: The first missing connector names itself.
      await loadConnector(db, connectorId, user.workspaceId);
    }
  };

  /** The connectors one agent has, with how each picks its credential. */
  const assignments = async (
    principal: Principal,
    input: z.input<typeof agentInputSchema>
  ): Promise<AssignmentSummary[]> => {
    const user = requireAssigner(principal, ASSIGNMENTS_ACTION);
    const { agentId } = agentInputSchema.parse(input);
    authorize(user, ASSIGNMENTS_ACTION, {
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    const rows = await db
      .select({
        agentId: agentConnectors.agentId,
        allowedTools: agentConnectors.allowedTools,
        connectorId: agentConnectors.connectorId,
        createdAt: agentConnectors.createdAt,
        credentialMode: agentConnectors.credentialMode,
      })
      .from(agentConnectors)
      .where(
        and(
          eq(agentConnectors.agentId, agentId),
          eq(agentConnectors.workspaceId, user.workspaceId)
        )
      )
      .orderBy(
        asc(agentConnectors.createdAt),
        asc(agentConnectors.connectorId)
      );
    return rows.map((row) => ({
      ...row,
      allowedTools: decodeAllowedTools(row.allowedTools),
    }));
  };

  /** Agent configuration metadata for people; no registry credentials or OAuth config. */
  const agentTools = async (
    principal: Principal,
    input: { agentId: string }
  ) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("agents.read");
    }
    authorize(principal, "agents.read", {
      id: input.agentId,
      kind: "agent",
      workspaceId: principal.workspaceId,
    });
    const rows = await db
      .select({
        allowedTools: agentConnectors.allowedTools,
        connectorId: connectors.id,
        name: connectors.name,
        status: connectors.status,
        tools: connectors.tools,
      })
      .from(agentConnectors)
      .innerJoin(
        connectors,
        and(
          eq(connectors.id, agentConnectors.connectorId),
          eq(connectors.workspaceId, agentConnectors.workspaceId)
        )
      )
      .where(
        and(
          eq(agentConnectors.workspaceId, principal.workspaceId),
          eq(agentConnectors.agentId, input.agentId)
        )
      )
      .orderBy(
        asc(agentConnectors.createdAt),
        asc(agentConnectors.connectorId)
      );
    return rows.map((row) => ({
      ...row,
      allowedTools: decodeAllowedTools(row.allowedTools),
      tools: toolSchema.parse(JSON.parse(row.tools)),
    }));
  };

  return {
    agentTools,
    assertExist,
    assign,
    assignments,
    create,
    list,
    remove,
    setAuthMode,
    setCallTimeout,
    setCredential,
    unassign,
  };
};

export type ConnectorsService = ReturnType<typeof createConnectorsService>;
