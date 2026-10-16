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
} from "@repo/db/schema/connectors";
import {
  type ConnectorAuthKind,
  type ConnectorStatus,
  CREDENTIAL_MODES,
  type CredentialMode,
  type CredentialOwnerKind,
  type CredentialStatus,
} from "@repo/db/shared";
import { and, asc, eq, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  type CachedTool,
  type Fetcher,
  McpError,
  McpUnauthorizedError,
  probeMcpServer,
} from "./connectors/mcp.ts";
import {
  canonicalizeConnectorUrl,
  InvalidConnectorUrlError,
} from "./connectors/url.ts";
import { encryptSecret, importSecretsKey } from "./crypto.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const CONNECTOR_KIND = "connector";
const CREATE_ACTION = "connectors.create";
const LIST_ACTION = "connectors.list";
const SET_CREDENTIAL_ACTION = "connectors.setCredential";
const ASSIGN_ACTION = "connectors.assign";
const UNASSIGN_ACTION = "connectors.unassign";
const ASSIGNMENTS_ACTION = "connectors.assignments";

const DEFAULT_HEADER_NAME = "Authorization";
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
/** Visible ASCII and spaces: a header value cannot carry control characters. */
const HEADER_VALUE_PATTERN = /^[ -~]+$/;
const RESOURCE_METADATA = "resource_metadata";
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

export const connectorCreateSchema = z.strictObject({
  headerName: headerNameSchema.optional(),
  name: z.string().trim().min(1).max(80),
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

export const assignmentInputSchema = z.strictObject({
  agentId: idString,
  connectorId: idString,
  credentialMode: z.enum(CREDENTIAL_MODES).default("user_or_agent"),
});
export type AssignmentInput = z.input<typeof assignmentInputSchema>;

export const unassignInputSchema = z.strictObject({
  agentId: idString,
  connectorId: idString,
});

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
  createdAt: string;
  headerName: string | null;
  id: string;
  /** The calling user's own credential, if they pasted one. */
  myCredential: CredentialSummary | null;
  name: string;
  status: ConnectorStatus;
  tools: CachedTool[];
  toolsFetchedAt: string | null;
  url: string;
}

export interface AssignmentSummary {
  agentId: string;
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

const toolSchema = z.array(
  z.object({ description: z.string().nullable(), name: z.string() })
);

const toCredentialSummary = (row: CredentialRow): CredentialSummary => ({
  createdAt: row.createdAt,
  id: row.id,
  ownerId: row.ownerId,
  ownerKind: row.ownerKind,
  status: row.status,
  updatedAt: row.updatedAt,
  version: row.version,
});

const toSummary = (
  row: ConnectorRow,
  owned: readonly CredentialRow[],
  userId: string
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
    createdAt: row.createdAt,
    headerName: row.headerName,
    id: row.id,
    myCredential: mine ? toCredentialSummary(mine) : null,
    name: row.name,
    status: row.status,
    tools: toolSchema.parse(JSON.parse(row.tools)),
    toolsFetchedAt: row.toolsFetchedAt,
    url: row.url,
  };
};

const invalid = (message: string): ServiceError =>
  new ServiceError("invalid", message);

const conflictOnSave = (): ServiceError =>
  new ServiceError(
    "conflict",
    "A credential was just saved for this owner, try again"
  );

/** Keys and connectors are managed from a signed-in session. */
const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

type ProbeOutcome =
  | { kind: "ok"; tools: CachedTool[] }
  | { kind: "unauthorized"; wwwAuthenticate: string | null };

export const createConnectorsService = ({
  atomic,
  clock,
  db,
  events,
  fetch: fetchImpl,
  secretsKey,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  fetch: Fetcher;
  /** `SECRETS_KEY`, base64. Needed only to store a credential. */
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

  /**
   * One round trip to the server. A 401 or 403 is an outcome, not an error.
   * Anything else that goes wrong is a refusal written for the user, with
   * `redact` (a pasted secret) scrubbed from the server's own words.
   */
  const probe = async (
    url: string,
    header?: { name: string; value: string }
  ): Promise<ProbeOutcome> => {
    try {
      const result = await probeMcpServer(url, { fetchImpl, header });
      return { kind: "ok", tools: result.tools };
    } catch (error: unknown) {
      if (error instanceof McpUnauthorizedError) {
        return { kind: "unauthorized", wwwAuthenticate: error.wwwAuthenticate };
      }
      const detail = error instanceof McpError ? ` ${error.message}` : "";
      const message = `Could not read the tool list from that server.${detail}`;
      throw invalid(
        header ? message.replaceAll(header.value, "[redacted]") : message
      );
    }
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

  const loadConnector = async (
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

  const loadActiveAgent = async (agentId: string, workspaceId: string) => {
    const agent = await findAgent(db, { id: agentId, workspaceId });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    if (agent.status !== "active") {
      throw new ServiceError("invalid", "That agent is archived");
    }
    return agent;
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

    const outcome = await probe(url);
    const now = clock.now();
    let authKind: ConnectorAuthKind = "none";
    let status: ConnectorStatus = "ok";
    let tools: CachedTool[] = [];
    if (outcome.kind === "ok") {
      ({ tools } = outcome);
    } else {
      // Only a server that points at its OAuth metadata is called OAuth here.
      // The discovery that makes it connectable is M3.2.
      authKind = outcome.wwwAuthenticate?.includes(RESOURCE_METADATA)
        ? "oauth"
        : "header";
      status = "needs_auth";
    }
    const row: ConnectorRow = {
      authKind,
      createdAt: now.toISOString(),
      createdBy: user.userId,
      headerName:
        authKind === "header"
          ? (parsed.headerName ?? DEFAULT_HEADER_NAME)
          : null,
      id: ulid(now.getTime()),
      name: parsed.name,
      oauth: null,
      status,
      tools: JSON.stringify(tools),
      toolsFetchedAt: outcome.kind === "ok" ? now.toISOString() : null,
      url,
      workspaceId: user.workspaceId,
    };
    await db.insert(connectors).values(row);
    return toSummary(row, [], user.userId);
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
    return rows.map((row) =>
      toSummary(
        row,
        owned.filter((credential) => credential.connectorId === row.id),
        user.userId
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
    const connector = await loadConnector(parsed.connectorId, workspaceId);
    if (connector.authKind !== "header") {
      throw new ServiceError(
        "invalid",
        "Only a connector that takes a header accepts a pasted value"
      );
    }
    const owner: { id: string; kind: CredentialOwnerKind } = parsed.agentId
      ? {
          id: (await loadActiveAgent(parsed.agentId, workspaceId)).id,
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

    const [existing] = await db
      .select({ id: credentials.id, version: credentials.version })
      .from(credentials)
      .where(
        and(
          eq(credentials.connectorId, connector.id),
          eq(credentials.ownerKind, owner.kind),
          eq(credentials.ownerId, owner.id)
        )
      )
      .limit(1);
    const rowId = existing?.id ?? ulid(nowDate.getTime());
    const secret = await encryptSecret(
      key,
      { field: "secret", rowId, table: "credentials", workspaceId },
      parsed.value
    );
    const refreshTools = db
      .update(connectors)
      .set({
        status: "ok",
        tools: JSON.stringify(outcome.tools),
        toolsFetchedAt: now,
      })
      .where(eq(connectors.id, connector.id));
    try {
      if (existing) {
        // The version fence: a paste that read an older version writes nothing.
        const replaced = await db
          .update(credentials)
          .set({
            expiresAt: null,
            refreshingUntil: null,
            secret,
            status: "ok",
            updatedAt: now,
            version: existing.version + 1,
          })
          .where(
            and(
              eq(credentials.id, rowId),
              eq(credentials.version, existing.version)
            )
          )
          .returning({ id: credentials.id });
        if (replaced.length === 0) {
          throw conflictOnSave();
        }
        await refreshTools;
      } else {
        await atomic([
          db.insert(credentials).values({
            connectorId: connector.id,
            createdAt: now,
            createdBy: user.userId,
            id: rowId,
            ownerId: owner.id,
            ownerKind: owner.kind,
            secret,
            status: "ok",
            updatedAt: now,
            version: 1,
            workspaceId,
          }),
          refreshTools,
        ]);
      }
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw conflictOnSave();
      }
      throw error;
    }
    await events.append({
      actor: { id: user.userId, kind: "user" },
      agentId: owner.kind === "agent" ? owner.id : null,
      payload: {
        connectorId: connector.id,
        ownerId: owner.id,
        ownerKind: owner.kind,
        replaced: existing !== undefined,
      },
      type: "credential.created",
      workspaceId,
    });
    const [saved] = await db
      .select(credentialColumns)
      .from(credentials)
      .where(eq(credentials.id, rowId))
      .limit(1);
    if (!saved) {
      throw new ServiceError("not_found", "Credential not found");
    }
    return toCredentialSummary(saved);
  };

  /** Gives an agent a connector, or changes how its credential is chosen. */
  const assign = async (
    principal: Principal,
    input: AssignmentInput
  ): Promise<AssignmentSummary> => {
    const user = requireUser(principal, ASSIGN_ACTION);
    const parsed = assignmentInputSchema.parse(input);
    const { workspaceId } = user;
    authorize(user, ASSIGN_ACTION, {
      id: parsed.connectorId,
      kind: CONNECTOR_KIND,
      workspaceId,
    });
    await loadActiveAgent(parsed.agentId, workspaceId);
    await loadConnector(parsed.connectorId, workspaceId);
    const createdAt = clock.now().toISOString();
    await db
      .insert(agentConnectors)
      .values({
        agentId: parsed.agentId,
        connectorId: parsed.connectorId,
        createdAt,
        credentialMode: parsed.credentialMode,
        workspaceId,
      })
      .onConflictDoUpdate({
        set: { credentialMode: parsed.credentialMode },
        target: [agentConnectors.agentId, agentConnectors.connectorId],
      });
    const [row] = await db
      .select({
        agentId: agentConnectors.agentId,
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
    return row;
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

  /** The connectors one agent has, with how each picks its credential. */
  const assignments = async (
    principal: Principal,
    input: z.input<typeof agentInputSchema>
  ): Promise<AssignmentSummary[]> => {
    const user = requireUser(principal, ASSIGNMENTS_ACTION);
    const { agentId } = agentInputSchema.parse(input);
    authorize(user, ASSIGNMENTS_ACTION, {
      kind: CONNECTOR_KIND,
      workspaceId: user.workspaceId,
    });
    return await db
      .select({
        agentId: agentConnectors.agentId,
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
  };

  return { assign, assignments, create, list, setCredential, unassign };
};

export type ConnectorsService = ReturnType<typeof createConnectorsService>;
