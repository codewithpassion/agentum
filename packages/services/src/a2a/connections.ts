/**
 * Agent connections: publishing an agent, pairing it with another Harbourmaster,
 * giving an outside client an access key, calling an outside agent, and
 * withdrawing any of them. The spec is docs/v3/agent-connections.md.
 *
 * No HTTP happens here. A call that must reach a peer and answer (the invite
 * `join`) goes through the injected `PairingTransport`. One that may be retried
 * becomes an `a2a_outbox` row, which AA.5 delivers. The routes (AA.4) call the
 * bearer methods, `join`, `activate`, `declined`, `peerRevoked` and
 * `authenticate`, and the page calls the rest.
 *
 * Tokens are shown once and stored as SHA-256 hashes. The credential we present
 * to a peer is encrypted with the secrets key, bound to its row. A token that
 * must wait in the outbox (the one an approval sends to the joiner) is
 * encrypted there too, so no plaintext token is ever in the database or in an
 * event payload.
 */

import {
  type AgentCard,
  agentCardSchema,
  agentSkillSchema,
} from "@repo/a2a/agent-card";
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { a2aAgentCards, a2aConnections, a2aOutbox } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  A2A_INBOUND_POLICIES,
  A2A_OUTBOUND_POLICIES,
  A2A_TOOL_POLICIES,
  type A2aConnectionStatus,
  type A2aInboundPolicy,
  type A2aOutboundPolicy,
  type A2aPeerKind,
  type A2aToolPolicy,
  type EventActorKind,
  type EventType,
} from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { type AgentRecord, findAgent, slugify } from "../agents.ts";
import { authorize, ForbiddenError } from "../authz.ts";
import { checkUrl } from "../connectors/safe-url.ts";
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hashedToken,
  hashToken,
  importSecretsKey,
  type SecretBinding,
  toBase64Url,
  tokenMatchesHash,
} from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import {
  CONNECTION_KIND,
  requireAdminOrOwner,
  requireReader,
  requireSession,
  type SessionUser,
} from "./access.ts";
import {
  chooseInterface,
  chooseOutboundScheme,
  type OutboundScheme,
  schemeKindOfLabel,
  schemeLabel,
  tokenUrlOfLabel,
} from "./card-peer.ts";
import { checkCode } from "./pairing-code.ts";
import {
  ACCESS_TOKEN_PREFIX,
  cardUrlOf,
  connectionIdOfInvite,
  connectLinkOf,
  INVITE_TOKEN_PREFIX,
  interfaceBaseOfCardUrl,
  isOnOrigin,
  parseInviteLink,
  publicIdOfCardUrl,
} from "./urls.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * DAY_MS;
/** Wrong tries an invite survives. The fifth ends it. */
export const INVITE_MAX_FAILURES = 5;
/** Characters of a token kept next to its hash. */
const HINT_LENGTH = 4;
const PUBLIC_ID_BYTES = 18;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_FALLBACK = "peer";
const RADIX_36 = 36;
const BEARER_MIN = 32;
const TEXT_MAX = 2000;

/** Statuses of a connection that has ended. */
const ENDED: readonly A2aConnectionStatus[] = ["declined", "revoked"];

const INVITE_REFUSED = "This invite is not valid.";
const PUBLISH_FIRST = "Publish the agent first.";

export const PUBLISH_ACTION = "a2a.publish";
export const UNPUBLISH_ACTION = "a2a.unpublish";
export const INVITE_ACTION = "a2a.invite";
export const JOIN_ACTION = "a2a.join";
export const APPROVE_ACTION = "a2a.approve";
export const DECLINE_ACTION = "a2a.decline";
export const KEY_ACTION = "a2a.key";
export const OUTBOUND_ACTION = "a2a.outbound";
export const REFRESH_ACTION = "a2a.refresh";
export const POLICIES_ACTION = "a2a.policies";
export const REVOKE_ACTION = "a2a.revoke";
export const READ_ACTION = "a2a.read";

export type PeerPrincipal = Extract<Principal, { kind: "peer" }>;

const idString = z.string().min(1).max(200);

export const skillInputSchema = agentSkillSchema.pick({
  description: true,
  examples: true,
  id: true,
  name: true,
  tags: true,
});

export const publishInputSchema = z.strictObject({
  agentId: idString,
  description: z.string().trim().min(1).max(TEXT_MAX),
  skills: z.array(skillInputSchema).min(1).max(20),
});
export type PublishInput = z.input<typeof publishInputSchema>;

export const agentIdInputSchema = z.strictObject({ agentId: idString });

export const joinWithLinkInputSchema = z.strictObject({
  agentId: idString,
  link: z.string().trim().min(1).max(2000),
});
export type JoinWithLinkInput = z.input<typeof joinWithLinkInputSchema>;

/** What the joiner sends the inviter. `token` lets the inviter's agent call the joiner's. */
export const pairJoinBodySchema = z.strictObject({
  agentName: z.string().trim().min(1).max(200),
  cardUrl: z.url().max(2000),
  orgName: z.string().trim().max(200).optional(),
  token: z.string().min(BEARER_MIN).max(500),
});
export type PairJoinBody = z.input<typeof pairJoinBodySchema>;

/** What the inviter answers: its own agent, as the joiner will show it. */
export const pairJoinResultSchema = z.strictObject({
  agentName: z.string().trim().min(1).max(200),
  cardUrl: z.url().max(2000),
  orgName: z.string().trim().max(200),
});
export type PairJoinResult = z.infer<typeof pairJoinResultSchema>;

/** What the inviter sends the joiner when it approves. */
export const pairActivateBodySchema = z.strictObject({
  token: z.string().min(BEARER_MIN).max(500),
});
export type PairActivateBody = z.input<typeof pairActivateBodySchema>;

export const accessKeyInputSchema = z.strictObject({
  agentId: idString,
  label: z.string().trim().min(1).max(80),
});
export type AccessKeyInput = z.input<typeof accessKeyInputSchema>;

const oauthCredentialSchema = z.strictObject({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(2000),
});

/** What `addOutbound` seals for an OAuth client credentials agent. */
const storedOauthSchema = oauthCredentialSchema.extend({
  scopes: z.array(z.string()),
  tokenUrl: z.string(),
});

export const addOutboundInputSchema = z.strictObject({
  agentId: idString,
  cardUrl: z.url().max(2000),
  credential: z
    .union([z.string().min(1).max(4000), oauthCredentialSchema])
    .optional(),
  label: z.string().trim().min(1).max(80).optional(),
});
export type AddOutboundInput = z.input<typeof addOutboundInputSchema>;

export const previewCardInputSchema = z.strictObject({
  agentId: idString,
  cardUrl: z.url().max(2000),
});
export type PreviewCardInput = z.input<typeof previewCardInputSchema>;

/** What the "Call it" dialog shows before it asks for a credential. All of it is the peer's own text. */
export interface CardPreview {
  description: string;
  host: string;
  name: string;
  org: string | null;
  /** The kind of credential the card asks for: `none`, `bearer`, `api_key_header` or `oauth2_client_credentials`. */
  scheme: OutboundScheme["kind"];
  skills: { description: string; name: string }[];
}

export const policiesInputSchema = z
  .strictObject({
    connectionId: idString,
    hourlyLimit: z.number().int().min(1).max(10_000).optional(),
    inboundPolicy: z.enum(A2A_INBOUND_POLICIES).optional(),
    outboundPolicy: z.enum(A2A_OUTBOUND_POLICIES).optional(),
    toolPolicy: z.enum(A2A_TOOL_POLICIES).optional(),
  })
  .refine(
    (input) =>
      input.hourlyLimit !== undefined ||
      input.inboundPolicy !== undefined ||
      input.outboundPolicy !== undefined ||
      input.toolPolicy !== undefined,
    { message: "Change at least one setting" }
  );
export type PoliciesInput = z.input<typeof policiesInputSchema>;

/** The destination a person looked at when they approved. */
export const approveSeenSchema = z.strictObject({
  origin: z.string().min(1).max(2000),
  tokenUrl: z.string().min(1).max(2000).nullable(),
});
export type ApproveSeen = z.input<typeof approveSeenSchema>;

export const listInputSchema = z.strictObject({
  agentId: idString.optional(),
});
export type ListConnectionsInput = z.input<typeof listInputSchema>;

/** The card of a published agent, as the route builds the A2A card from it. Never carries instructions. */
export interface PublicCard {
  agentName: string;
  description: string;
  publicId: string;
  skills: z.infer<typeof skillInputSchema>[];
}

/** An agent's publication, as the page shows it. */
export interface PublishedCard {
  agentId: string;
  cardUrl: string;
  description: string;
  pairingOpen: boolean;
  publicId: string;
  publishedAt: string;
  skills: z.infer<typeof skillInputSchema>[];
  unpublishedAt: string | null;
}

/** A connection as the page may see it. Never carries a hash, a token or a credential. */
export interface ConnectionSummary {
  agentId: string;
  agentName: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** What both people compare while the connection is pending. It stays after. */
  checkCode: string | null;
  createdAt: string;
  createdBy: string;
  hourlyLimit: number;
  id: string;
  inboundPolicy: A2aInboundPolicy;
  inviteExpiresAt: string | null;
  lastInAt: string | null;
  lastOutAt: string | null;
  outboundPolicy: A2aOutboundPolicy;
  peerCardUrl: string | null;
  peerKind: A2aPeerKind;
  peerLabel: string | null;
  peerOrg: string | null;
  peerOrigin: string | null;
  /** The origin a refreshed card names while a person has yet to approve it. */
  pendingOrigin: string | null;
  /** The OAuth token URL a refreshed card names while a person has yet to approve it. */
  pendingTokenUrl: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  slug: string;
  status: A2aConnectionStatus;
  /** The start of the token the peer sends us. */
  tokenPrefix: string | null;
  /**
   * The OAuth token URL a person approved, where the client secret goes. Null
   * for any other scheme. To approve a connection, send back
   * `pendingOrigin ?? peerOrigin` as the origin and
   * `pendingTokenUrl ?? tokenUrl` as the token URL.
   */
  tokenUrl: string | null;
  toolPolicy: A2aToolPolicy;
}

/** A connection that ended, as the revoke hook hands it over. */
export interface RevokedConnection {
  agentId: string;
  connectionId: string;
  peerKind: A2aPeerKind;
  workspaceId: string;
}

/** Runs after a connection is revoked. AA.3 ends the tasks and runs of that connection here. */
export type RevokedListener = (revoked: RevokedConnection) => Promise<void>;

/**
 * The calls that cannot be queued. AA.5 supplies the real one. On one
 * deployment it dispatches in-process. Both must refuse a URL the safe-URL
 * guard refuses.
 */
export interface PairingTransport {
  /** `POST <url>` with `bearer`, body `{ token }`. Rejects when the peer did not accept. */
  activate: (input: {
    bearer: string;
    token: string;
    url: string;
  }) => Promise<void>;
  /** `POST <origin>/a2a/pair/join` with the invite as bearer. Resolves to the inviter's answer. */
  join: (input: {
    body: PairJoinBody;
    inviteToken: string;
    origin: string;
  }) => Promise<unknown>;
}

export interface ConnectionsOptions {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  /** Fetches an agent card over HTTPS through the safe-URL guard. Resolves to the parsed JSON. */
  fetchCard?: (url: string) => Promise<unknown>;
  /** `PUBLIC_BASE_URL`. Without one nothing can be published or invited. */
  publicBaseUrl?: string;
  /** `SECRETS_KEY`. Storing a credential encrypts with it. */
  secretsKey?: string;
  transport?: PairingTransport;
}

type ConnectionRow = typeof a2aConnections.$inferSelect;

const summaryColumns = {
  agentId: a2aConnections.localAgentId,
  agentName: agents.name,
  approvedAt: a2aConnections.approvedAt,
  approvedBy: a2aConnections.approvedBy,
  checkCode: a2aConnections.checkCode,
  createdAt: a2aConnections.createdAt,
  createdBy: a2aConnections.createdBy,
  hourlyLimit: a2aConnections.hourlyLimit,
  id: a2aConnections.id,
  inboundPolicy: a2aConnections.inboundPolicy,
  inviteExpiresAt: a2aConnections.inviteExpiresAt,
  lastInAt: a2aConnections.lastInAt,
  lastOutAt: a2aConnections.lastOutAt,
  outboundPolicy: a2aConnections.outboundPolicy,
  outboundScheme: a2aConnections.outboundScheme,
  peerCard: a2aConnections.peerCard,
  peerCardUrl: a2aConnections.peerCardUrl,
  peerKind: a2aConnections.peerKind,
  peerLabel: a2aConnections.peerLabel,
  peerOrg: a2aConnections.peerOrg,
  peerOrigin: a2aConnections.peerOrigin,
  revokedAt: a2aConnections.revokedAt,
  revokedBy: a2aConnections.revokedBy,
  slug: a2aConnections.slug,
  status: a2aConnections.status,
  tokenPrefix: a2aConnections.inboundTokenPrefix,
  toolPolicy: a2aConnections.toolPolicy,
};

type SummaryRow = Omit<
  ConnectionSummary,
  "pendingOrigin" | "pendingTokenUrl" | "tokenUrl"
> & {
  outboundScheme: string | null;
  peerCard: string | null;
};

/** A summary row with the card dropped and the destination awaiting approval worked out. */
const toSummary = ({
  outboundScheme,
  peerCard,
  ...row
}: SummaryRow): ConnectionSummary => {
  const card =
    row.status === "needs_approval" && row.peerKind === "a2a_outbound"
      ? parseStoredCard(peerCard)
      : null;
  const pending = card ? chooseInterface(card) : null;
  const scheme = card ? chooseOutboundScheme(card) : null;
  return {
    ...row,
    pendingOrigin: pending ? pending.origin : null,
    pendingTokenUrl:
      scheme?.ok && scheme.scheme.kind === "oauth2_client_credentials"
        ? scheme.scheme.tokenUrl
        : null,
    tokenUrl: tokenUrlOfLabel(outboundScheme),
  };
};

/** The start of a token, kept next to its hash so connections can be told apart. */
const tokenHint = (token: string): string =>
  token.slice(0, ACCESS_TOKEN_PREFIX.length + HINT_LENGTH);

/** How wide each setting is. A change to a higher number widens access. */
const WIDTH = {
  inbound: { approve: 1, auto: 2, off: 0 },
  outbound: { approve: 1, auto: 2, off: 0 },
  tool: { agent_rules: 1, ask: 0 },
} as const;

const randomText = (length: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes]
    .map((byte) => (byte % RADIX_36).toString(RADIX_36))
    .join("");
};

/** The card a connection stored, or null when there is none or it no longer parses. */
const parseStoredCard = (stored: string | null) => {
  if (stored === null) {
    return null;
  }
  try {
    const parsed = agentCardSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The label of the scheme a card asks for, or null when v1 cannot send it. */
const labelOfCard = (card: AgentCard | null): string | null => {
  const choice = card ? chooseOutboundScheme(card) : null;
  return choice?.ok ? schemeLabel(choice.scheme) : null;
};

/**
 * What a freshly fetched card changes for a connection. The destination of the
 * credential is the interface origin plus, for OAuth, the token URL (the scheme
 * label carries it). `needsPerson` compares it with what a person approved.
 * `movedAgain` compares it with the card stored last, so a card that moves a
 * second time while a person is looking is noticed.
 */
const compareCard = (
  found: Pick<ConnectionRow, "outboundScheme" | "peerCard" | "peerOrigin">,
  card: AgentCard
): {
  label: string | null;
  movedAgain: boolean;
  needsPerson: boolean;
  origin: string | null;
} => {
  const earlier = parseStoredCard(found.peerCard);
  const earlierInterface = earlier ? chooseInterface(earlier) : null;
  const nowInterface = chooseInterface(card);
  const origin = nowInterface ? nowInterface.origin : null;
  const label = labelOfCard(card);
  return {
    label,
    movedAgain:
      origin !== (earlierInterface ? earlierInterface.origin : null) ||
      label !== labelOfCard(earlier),
    needsPerson: origin !== found.peerOrigin || label !== found.outboundScheme,
    origin,
  };
};

const reasonOf = (needsPerson: boolean, originMoved: boolean): string => {
  if (!needsPerson) {
    return "restored";
  }
  return originMoved ? "origin" : "scheme";
};

/** What the system acts as in the log. */
const SYSTEM_ACTOR = { id: "tick", kind: "system" } as const;

export const createConnectionsService = ({
  atomic,
  clock,
  db,
  events,
  fetchCard,
  publicBaseUrl: configuredBaseUrl,
  secretsKey,
  transport,
}: ConnectionsOptions) => {
  const publicBaseUrl = configuredBaseUrl ?? "";
  const revokedListeners: RevokedListener[] = [];
  let importedKey: Promise<CryptoKey> | undefined;

  const secretKey = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Storing a credential needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const seal = async (binding: SecretBinding, plaintext: string) =>
    await encryptSecret(await secretKey(), binding, plaintext);

  const unseal = async (binding: SecretBinding, stored: string) =>
    await decryptSecret(await secretKey(), binding, stored);

  const credentialBinding = (row: {
    id: string;
    workspaceId: string;
  }): SecretBinding => ({
    field: "outbound_credential",
    rowId: row.id,
    table: "a2a_connections",
    workspaceId: row.workspaceId,
  });

  const requireBase = (): string => {
    if (publicBaseUrl === "") {
      throw new ServiceError("invalid", "PUBLIC_BASE_URL is not set");
    }
    return publicBaseUrl;
  };

  const nowIso = () => clock.now().toISOString();

  // ---------------------------------------------------------------------
  // Events and lookups

  const record = async (input: {
    actor: { id: string; kind: EventActorKind };
    agentId: string;
    payload?: Record<string, string | number | boolean | null>;
    type: EventType;
    workspaceId: string;
  }): Promise<void> => {
    await events.append({
      actor: input.actor,
      agentId: input.agentId,
      payload: input.payload ?? {},
      type: input.type,
      workspaceId: input.workspaceId,
    });
  };

  const actorOf = (principal: Principal) =>
    principal.kind === "user"
      ? ({ id: principal.userId, kind: "user" } as const)
      : SYSTEM_ACTOR;

  const peerActor = (row: { id: string }) =>
    ({ id: row.id, kind: "peer" }) as const;

  const findRow = async (
    id: string,
    workspaceId: string
  ): Promise<ConnectionRow | null> => {
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.id, id),
          eq(a2aConnections.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const requireRow = async (id: string, workspaceId: string) => {
    const row = await findRow(id, workspaceId);
    if (!row) {
      throw new ServiceError("not_found", "Connection not found");
    }
    return row;
  };

  const requireActiveAgent = async (
    agentId: string,
    workspaceId: string
  ): Promise<AgentRecord> => {
    const agent = await findAgent(db, { id: agentId, workspaceId });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    return agent;
  };

  const findSummary = async (
    id: string,
    workspaceId: string
  ): Promise<ConnectionSummary | null> => {
    const [row] = await db
      .select(summaryColumns)
      .from(a2aConnections)
      .innerJoin(agents, eq(agents.id, a2aConnections.localAgentId))
      .where(
        and(
          eq(a2aConnections.id, id),
          eq(a2aConnections.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ? toSummary(row) : null;
  };

  const requireSummary = async (id: string, workspaceId: string) => {
    const summary = await findSummary(id, workspaceId);
    if (!summary) {
      throw new ServiceError("not_found", "Connection not found");
    }
    return summary;
  };

  const findCard = async (agentId: string) => {
    const [card] = await db
      .select()
      .from(a2aAgentCards)
      .where(eq(a2aAgentCards.agentId, agentId))
      .limit(1);
    return card ?? null;
  };

  /** The card of an agent that is published right now, or a refusal. */
  const requirePublished = async (agentId: string) => {
    const card = await findCard(agentId);
    if (!card || card.unpublishedAt !== null) {
      throw new ServiceError("invalid", PUBLISH_FIRST);
    }
    return card;
  };

  const workspaceName = async (workspaceId: string): Promise<string> => {
    const [row] = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return row?.name ?? "";
  };

  /** A slug no other connection of the workspace uses. */
  const freeSlug = async (
    workspaceId: string,
    wanted: string
  ): Promise<string> => {
    const base = slugify(wanted) || SLUG_FALLBACK;
    const [taken] = await db
      .select({ id: a2aConnections.id })
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.workspaceId, workspaceId),
          eq(a2aConnections.slug, base)
        )
      )
      .limit(1);
    return taken ? `${base}-${randomText(SLUG_SUFFIX_LENGTH)}` : base;
  };

  /** Refuses a second live connection between one agent and one peer card. */
  const refuseDuplicate = async (
    agentId: string,
    peerCardUrl: string,
    exceptId?: string
  ): Promise<void> => {
    const rows = await db
      .select({ id: a2aConnections.id })
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.localAgentId, agentId),
          eq(a2aConnections.peerCardUrl, peerCardUrl),
          notInArray(a2aConnections.status, [...ENDED])
        )
      );
    if (rows.some((row) => row.id !== exceptId)) {
      throw new ServiceError(
        "conflict",
        "That agent is already connected to this peer"
      );
    }
  };

  /**
   * The workspace behind a card URL on this deployment, or null for a URL on
   * another origin. Its name is taken from our own row, never from the peer's
   * claim.
   */
  const localPeer = async (
    cardUrl: string
  ): Promise<{ workspaceId: string; workspaceName: string } | null> => {
    if (!isOnOrigin(cardUrl, publicBaseUrl)) {
      return null;
    }
    const publicId = publicIdOfCardUrl(cardUrl);
    if (publicId === null) {
      throw new ServiceError("invalid", "That is not an agent card URL");
    }
    const [row] = await db
      .select({
        workspaceId: a2aAgentCards.workspaceId,
        workspaceName: workspaces.name,
      })
      .from(a2aAgentCards)
      .innerJoin(workspaces, eq(workspaces.id, a2aAgentCards.workspaceId))
      .where(
        and(
          eq(a2aAgentCards.publicId, publicId),
          isNull(a2aAgentCards.unpublishedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("invalid", "That agent is not published here");
    }
    return row;
  };

  /** A URL that passes the safe-URL guard, or a refusal in the person's words. */
  const vetUrl = (raw: string): URL => {
    const checked = checkUrl(raw);
    if (!checked.ok) {
      throw new ServiceError(
        "invalid",
        `That URL is not allowed: ${checked.reason}.`
      );
    }
    return checked.url;
  };

  /**
   * Checks a peer's card URL and says who it is. On this deployment the
   * organisation comes from our own row and a peer in our own workspace is
   * refused. Elsewhere the URL must be HTTPS and pass the safe-URL guard, and
   * the organisation is what the peer claims.
   */
  const vetPeer = async (
    cardUrl: string,
    claimedOrg: string | undefined,
    workspaceId: string
  ): Promise<{ origin: string; org: string | null }> => {
    const local = await localPeer(cardUrl);
    if (local) {
      if (local.workspaceId === workspaceId) {
        throw new ServiceError(
          "invalid",
          "An agent cannot connect to another agent in its own workspace"
        );
      }
      return { org: local.workspaceName, origin: new URL(cardUrl).origin };
    }
    const url = vetUrl(cardUrl);
    if (url.protocol !== "https:") {
      throw new ServiceError("invalid", "A peer must be reached over HTTPS");
    }
    return { org: claimedOrg?.trim() || null, origin: url.origin };
  };

  // ---------------------------------------------------------------------
  // The outbox

  type OutboxRow = typeof a2aOutbox.$inferInsert;

  /**
   * An outbox row that tells the peer, with the credential in its encrypted
   * headers. `secretBody` is sealed into the body under its own field name.
   */
  const outboxRow = async (
    row: Pick<ConnectionRow, "id" | "workspaceId">,
    input: {
      bearer: string;
      kind: OutboxRow["kind"];
      secretBody?: { field: string; value: string };
      url: string;
    }
  ): Promise<OutboxRow> => {
    const id = `obx_${ulid(clock.now().getTime())}`;
    const binding = (field: string): SecretBinding => ({
      field,
      rowId: id,
      table: "a2a_outbox",
      workspaceId: row.workspaceId,
    });
    return {
      attempts: 0,
      body: JSON.stringify(
        input.secretBody
          ? {
              [input.secretBody.field]: await seal(
                binding(`body.${input.secretBody.field}`),
                input.secretBody.value
              ),
            }
          : {}
      ),
      connectionId: row.id,
      createdAt: nowIso(),
      headers: await seal(
        binding("headers"),
        JSON.stringify({ Authorization: `Bearer ${input.bearer}` })
      ),
      id,
      kind: input.kind,
      nextAttemptAt: nowIso(),
      url: input.url,
      workspaceId: row.workspaceId,
    };
  };

  /** The insert of an outbox row that only lands while the connection is still in `status`. */
  const queueWhile = (row: OutboxRow, status: A2aConnectionStatus) =>
    db.insert(a2aOutbox).select(
      db
        .select({
          attempts: sql<number>`${row.attempts}`.as("attempts"),
          body: sql<string>`${row.body}`.as("body"),
          connectionId: sql<string>`${row.connectionId}`.as("connectionId"),
          createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
          headers: sql<string | null>`${row.headers}`.as("headers"),
          id: sql<string>`${row.id}`.as("id"),
          kind: sql<string>`${row.kind}`.as("kind"),
          nextAttemptAt: sql<string>`${row.nextAttemptAt}`.as("nextAttemptAt"),
          url: sql<string>`${row.url}`.as("url"),
          workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
        })
        .from(sql`(select 1)`)
        .where(
          sql`exists (select 1 from ${a2aConnections} where ${a2aConnections.id} = ${row.connectionId} and ${a2aConnections.status} = ${status})`
        )
    );

  /** Tells the peer, best effort: the access ended whether or not this lands. */
  const queueNoticeRaw = async (
    row: ConnectionRow,
    kind: "pair_decline" | "pair_revoke",
    path: string
  ): Promise<void> => {
    if (
      row.peerKind !== "harbourmaster" ||
      !row.outboundCredential ||
      !row.peerCardUrl
    ) {
      return;
    }
    const bearer = await unseal(credentialBinding(row), row.outboundCredential);
    await db.insert(a2aOutbox).values(
      await outboxRow(row, {
        bearer,
        kind,
        url: `${interfaceBaseOfCardUrl(row.peerCardUrl)}${path}`,
      })
    );
  };

  /**
   * `queueNoticeRaw` that never throws. The access has ended whether or not the
   * peer is told, so a notice that cannot be queued (an unreadable credential,
   * say) must not skip the event or the hook that follow.
   */
  const queueNotice = async (
    row: ConnectionRow,
    kind: "pair_decline" | "pair_revoke",
    path: string
  ): Promise<void> => {
    try {
      await queueNoticeRaw(row, kind, path);
    } catch (error) {
      console.error("A2A notice not queued", row.id, error);
    }
  };

  // ---------------------------------------------------------------------
  // Revoking

  const fireRevoked = async (revoked: RevokedConnection): Promise<void> => {
    for (const listener of revokedListeners) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: listeners run one at a time, in registration order
        await listener(revoked);
      } catch (error) {
        console.error("A2A revoke listener failed", error);
      }
    }
  };

  /**
   * Ends a connection, with no access check: the caller has made one. The
   * update only matches a row that has not ended, so a second call changes
   * nothing and does not fire the hook twice. Returns whether this call ended it.
   */
  const endConnection = async (
    row: ConnectionRow,
    by: {
      actor: { id: string; kind: EventActorKind };
      notify: boolean;
    }
  ): Promise<boolean> => {
    const ended = await db
      .update(a2aConnections)
      .set({
        inviteTokenHash: null,
        outboundCredential: null,
        revokedAt: nowIso(),
        revokedBy: by.actor.kind === "user" ? by.actor.id : by.actor.kind,
        status: "revoked",
      })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          notInArray(a2aConnections.status, [...ENDED])
        )
      )
      .returning({ id: a2aConnections.id });
    if (ended.length === 0) {
      return false;
    }
    // A pending activation must not be delivered after the revoke.
    await db
      .delete(a2aOutbox)
      .where(
        and(
          eq(a2aOutbox.connectionId, row.id),
          eq(a2aOutbox.kind, "pair_activate")
        )
      );
    if (by.notify) {
      await queueNotice(row, "pair_revoke", "/pair/revoke");
    }
    await record({
      actor: by.actor,
      agentId: row.localAgentId,
      payload: { connectionId: row.id, peerKind: row.peerKind },
      type: "a2a.connection_revoked",
      workspaceId: row.workspaceId,
    });
    await fireRevoked({
      agentId: row.localAgentId,
      connectionId: row.id,
      peerKind: row.peerKind,
      workspaceId: row.workspaceId,
    });
    return true;
  };

  // Archiving an agent revokes its connections. A listener must not throw, and
  // `authenticate` also checks the agent is active, so a failure here still
  // leaves every token dead.
  events.onAppend(async (event) => {
    if (
      event.type !== "agent.updated" ||
      event.payload.status !== "archived" ||
      !event.agentId
    ) {
      return;
    }
    const live = await db
      .select()
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.localAgentId, event.agentId),
          eq(a2aConnections.workspaceId, event.workspaceId ?? ""),
          notInArray(a2aConnections.status, [...ENDED])
        )
      );
    for (const row of live) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one connection at a time keeps the log in order
        await endConnection(row, {
          actor: event.actor.kind === "user" ? event.actor : SYSTEM_ACTOR,
          notify: true,
        });
      } catch (error) {
        // One failing row must not leave the others live.
        console.error("A2A archive revoke failed", row.id, error);
      }
    }
  });

  // ---------------------------------------------------------------------
  // Publishing

  const publishedCardOf = (
    card: typeof a2aAgentCards.$inferSelect
  ): PublishedCard => ({
    agentId: card.agentId,
    cardUrl: cardUrlOf(publicBaseUrl, card.publicId),
    description: card.description,
    pairingOpen: card.pairingOpen,
    publicId: card.publicId,
    publishedAt: card.publishedAt,
    skills: JSON.parse(card.skills) as PublishedCard["skills"],
    unpublishedAt: card.unpublishedAt,
  });

  /**
   * Publishes an agent with the description and skills its owner reviewed.
   * Publishing again after an unpublish keeps the public id, so a peer's saved
   * card URL still works. The agent's `instructions` are never read.
   */
  const publish = async (
    principal: Principal,
    input: PublishInput
  ): Promise<PublishedCard> => {
    const user = requireSession(principal, PUBLISH_ACTION);
    const { agentId, description, skills } = publishInputSchema.parse(input);
    authorize(user, PUBLISH_ACTION, {
      id: agentId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    requireBase();
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, PUBLISH_ACTION);
    if (agent.runtime === "managed") {
      throw new ServiceError(
        "invalid",
        "Agents on the managed runtime can't be published yet, because their tool calls can't be held for approval. Move the agent to the cloud or machine runtime first."
      );
    }
    const existing = await findCard(agentId);
    const now = nowIso();
    const fields = {
      description,
      publishedAt: now,
      publishedBy: user.userId,
      skills: JSON.stringify(skills),
      unpublishedAt: null,
    };
    if (existing) {
      await db
        .update(a2aAgentCards)
        .set(fields)
        .where(eq(a2aAgentCards.agentId, agentId));
    } else {
      await db.insert(a2aAgentCards).values({
        ...fields,
        agentId,
        id: `crd_${ulid(clock.now().getTime())}`,
        publicId: toBase64Url(
          crypto.getRandomValues(new Uint8Array(PUBLIC_ID_BYTES))
        ),
        workspaceId: user.workspaceId,
      });
    }
    const card = await requirePublished(agentId);
    await record({
      actor: actorOf(user),
      agentId,
      payload: { publicId: card.publicId, republished: existing !== null },
      type: "a2a.agent_published",
      workspaceId: user.workspaceId,
    });
    return publishedCardOf(card);
  };

  /** Takes the card down. Connections stay, but no token works until it is published again. */
  const unpublish = async (
    principal: Principal,
    agentId: string
  ): Promise<void> => {
    const user = requireSession(principal, UNPUBLISH_ACTION);
    authorize(user, UNPUBLISH_ACTION, {
      id: agentId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    await requireActiveAgent(agentId, user.workspaceId);
    const taken = await db
      .update(a2aAgentCards)
      .set({ unpublishedAt: nowIso() })
      .where(
        and(
          eq(a2aAgentCards.agentId, agentId),
          eq(a2aAgentCards.workspaceId, user.workspaceId),
          isNull(a2aAgentCards.unpublishedAt)
        )
      )
      .returning({ id: a2aAgentCards.id });
    if (taken.length === 0) {
      throw new ServiceError("conflict", "The agent is not published");
    }
    await record({
      actor: actorOf(user),
      agentId,
      type: "a2a.agent_unpublished",
      workspaceId: user.workspaceId,
    });
  };

  /** What `/a2a/<publicId>/.well-known/agent-card.json` serves, or null. For the route: no principal. */
  const publicCard = async (publicId: string): Promise<PublicCard | null> => {
    const [row] = await db
      .select({
        agentName: agents.name,
        description: a2aAgentCards.description,
        publicId: a2aAgentCards.publicId,
        skills: a2aAgentCards.skills,
      })
      .from(a2aAgentCards)
      .innerJoin(agents, eq(agents.id, a2aAgentCards.agentId))
      .where(
        and(
          eq(a2aAgentCards.publicId, publicId),
          isNull(a2aAgentCards.unpublishedAt),
          eq(agents.status, "active")
        )
      )
      .limit(1);
    return row
      ? { ...row, skills: JSON.parse(row.skills) as PublicCard["skills"] }
      : null;
  };

  // ---------------------------------------------------------------------
  // Harbourmaster to Harbourmaster: the inviter

  /** Makes an invite for a published agent. The link is the only copy of the token. */
  const createInvite = async (
    principal: Principal,
    input: z.input<typeof agentIdInputSchema>
  ): Promise<{ connection: ConnectionSummary; link: string }> => {
    const user = requireSession(principal, INVITE_ACTION);
    const { agentId } = agentIdInputSchema.parse(input);
    authorize(user, INVITE_ACTION, {
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const base = requireBase();
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, INVITE_ACTION);
    await requirePublished(agentId);
    const now = clock.now();
    const id = `con_${ulid(now.getTime())}`;
    const token = `${INVITE_TOKEN_PREFIX}${id}.${toBase64Url(
      crypto.getRandomValues(new Uint8Array(PUBLIC_ID_BYTES))
    )}`;
    await db.insert(a2aConnections).values({
      createdAt: now.toISOString(),
      createdBy: user.userId,
      id,
      inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      inviteTokenHash: await hashToken(token),
      localAgentId: agentId,
      peerKind: "harbourmaster",
      slug: await freeSlug(
        user.workspaceId,
        `invite-${randomText(SLUG_SUFFIX_LENGTH)}`
      ),
      status: "inviting",
      workspaceId: user.workspaceId,
    });
    await record({
      actor: actorOf(user),
      agentId,
      payload: { connectionId: id },
      type: "a2a.invite_created",
      workspaceId: user.workspaceId,
    });
    return {
      connection: await requireSummary(id, user.workspaceId),
      link: connectLinkOf(base, token),
    };
  };

  /** Counts a wrong try against its invite. The fifth ends the invite. */
  const failInvite = async (row: ConnectionRow): Promise<void> => {
    const [counted] = await db
      .update(a2aConnections)
      .set({ inviteFailures: sql`${a2aConnections.inviteFailures} + 1` })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "inviting")
        )
      )
      .returning({ failures: a2aConnections.inviteFailures });
    const dead =
      counted !== undefined && counted.failures >= INVITE_MAX_FAILURES;
    if (dead) {
      await db
        .update(a2aConnections)
        .set({
          inviteTokenHash: null,
          revokedAt: nowIso(),
          revokedBy: "system",
          status: "revoked",
        })
        .where(
          and(
            eq(a2aConnections.id, row.id),
            eq(a2aConnections.status, "inviting")
          )
        );
    }
    await record({
      actor: peerActor(row),
      agentId: row.localAgentId,
      payload: {
        connectionId: row.id,
        dead,
        failures: counted?.failures ?? row.inviteFailures,
      },
      type: "a2a.invite_failed",
      workspaceId: row.workspaceId,
    });
  };

  /**
   * The joiner's call, carrying the invite as bearer. A wrong secret counts
   * against the invite, and the fifth kills it, so a sixth try with the right
   * secret fails too. A right secret wins once: the update only matches a row
   * still `inviting`, so two joins cannot both succeed. The row waits for a
   * person (`needs_approval`) and the joiner's token is kept encrypted as the
   * credential this agent presents to it.
   */
  const join = async (
    inviteToken: string,
    input: PairJoinBody
  ): Promise<PairJoinResult> => {
    const id = connectionIdOfInvite(inviteToken);
    const [row] = id
      ? await db
          .select()
          .from(a2aConnections)
          .where(eq(a2aConnections.id, id))
          .limit(1)
      : [];
    if (
      row?.status !== "inviting" ||
      row.peerKind !== "harbourmaster" ||
      row.inviteTokenHash === null ||
      row.inviteFailures >= INVITE_MAX_FAILURES ||
      (row.inviteExpiresAt ?? "") <= nowIso()
    ) {
      throw new ServiceError("not_found", INVITE_REFUSED);
    }
    if (!(await tokenMatchesHash(inviteToken, row.inviteTokenHash))) {
      await failInvite(row);
      throw new ServiceError("not_found", INVITE_REFUSED);
    }
    const body = pairJoinBodySchema.parse(input);
    // Everything that can fail comes before the claim, which uses the invite up.
    const base = requireBase();
    const agent = await requireActiveAgent(row.localAgentId, row.workspaceId);
    const card = await requirePublished(row.localAgentId);
    const peer = await vetPeer(body.cardUrl, body.orgName, row.workspaceId);
    await refuseDuplicate(row.localAgentId, body.cardUrl, row.id);
    const code = await checkCode(inviteToken, body.token);
    const claimed = await db
      .update(a2aConnections)
      .set({
        checkCode: code,
        inviteTokenHash: null,
        outboundCredential: await seal(credentialBinding(row), body.token),
        outboundScheme: schemeLabel({ kind: "bearer" }),
        peerCardUrl: body.cardUrl,
        peerLabel: body.agentName,
        peerOrg: peer.org,
        peerOrigin: peer.origin,
        slug: await freeSlug(row.workspaceId, body.agentName),
        status: "needs_approval",
      })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "inviting"),
          eq(a2aConnections.inviteTokenHash, row.inviteTokenHash),
          lt(a2aConnections.inviteFailures, INVITE_MAX_FAILURES),
          gt(a2aConnections.inviteExpiresAt, nowIso())
        )
      )
      .returning({ id: a2aConnections.id });
    if (claimed.length === 0) {
      throw new ServiceError("not_found", INVITE_REFUSED);
    }
    await record({
      actor: peerActor(row),
      agentId: row.localAgentId,
      payload: {
        connectionId: row.id,
        peerOrg: peer.org,
        peerOrigin: peer.origin,
      },
      type: "a2a.connection_requested",
      workspaceId: row.workspaceId,
    });
    return {
      agentName: agent.name,
      cardUrl: cardUrlOf(base, card.publicId),
      orgName: await workspaceName(row.workspaceId),
    };
  };

  /**
   * A person approves a connection that waits for them. For another
   * Harbourmaster this mints the token that lets the joiner call us, queues the
   * activation call and tries to deliver it at once. The row is `activating`
   * until the joiner confirms. For an outside agent whose card moved to another
   * origin it approves the new origin.
   */
  const approve = async (
    principal: Principal,
    connectionId: string,
    seen: ApproveSeen
  ): Promise<ConnectionSummary> => {
    const user = requireSession(principal, APPROVE_ACTION);
    const looked = approveSeenSchema.parse(seen);
    authorize(user, APPROVE_ACTION, {
      id: connectionId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const row = await requireRow(connectionId, user.workspaceId);
    const agent = await requireActiveAgent(row.localAgentId, user.workspaceId);
    requireAdminOrOwner(user, agent, APPROVE_ACTION);
    if (row.status !== "needs_approval") {
      throw new ServiceError(
        "conflict",
        "Connection is not waiting for approval"
      );
    }
    if (row.peerKind === "a2a_outbound") {
      return await approveNewOrigin(user, row, looked);
    }
    // A Harbourmaster peer has no token URL, and its origin is the one shown.
    refuseUnseen(looked, { origin: row.peerOrigin, tokenUrl: null });
    if (
      row.peerKind !== "harbourmaster" ||
      !row.outboundCredential ||
      !row.peerCardUrl
    ) {
      throw new ServiceError(
        "conflict",
        "Connection is not waiting for approval"
      );
    }
    await requirePublished(row.localAgentId);
    const bearer = await unseal(credentialBinding(row), row.outboundCredential);
    const minted = await hashedToken(ACCESS_TOKEN_PREFIX);
    const url = `${interfaceBaseOfCardUrl(row.peerCardUrl)}/pair/activate`;
    const queued = await outboxRow(row, {
      bearer,
      kind: "pair_activate",
      secretBody: { field: "token", value: minted.token },
      url,
    });
    // One write: the row only moves, and the activation only queues, together.
    await atomic([
      queueWhile(queued, "needs_approval"),
      db
        .update(a2aConnections)
        .set({
          approvedAt: nowIso(),
          approvedBy: user.userId,
          inboundTokenHash: minted.hash,
          inboundTokenPrefix: tokenHint(minted.token),
          status: "activating",
        })
        .where(
          and(
            eq(a2aConnections.id, row.id),
            eq(a2aConnections.status, "needs_approval")
          )
        ),
    ]);
    const after = await requireRow(row.id, user.workspaceId);
    if (after.inboundTokenHash !== minted.hash) {
      throw new ServiceError(
        "conflict",
        "Connection is not waiting for approval"
      );
    }
    await record({
      actor: actorOf(user),
      agentId: row.localAgentId,
      payload: { connectionId: row.id },
      type: "a2a.connection_approved",
      workspaceId: row.workspaceId,
    });
    await deliverActivation(row, { bearer, token: minted.token, url });
    return await requireSummary(row.id, user.workspaceId);
  };

  /** Tries the activation now. A failure leaves the outbox row, and the row `activating`, for AA.5 to retry. */
  const deliverActivation = async (
    row: ConnectionRow,
    call: { bearer: string; token: string; url: string }
  ): Promise<void> => {
    if (!transport) {
      return;
    }
    try {
      await transport.activate(call);
    } catch {
      return;
    }
    await markActive(row);
  };

  /** `activating` becomes `active` and the queued activation goes. */
  const markActive = async (row: ConnectionRow): Promise<void> => {
    const [activated] = await db
      .update(a2aConnections)
      .set({ status: "active" })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "activating")
        )
      )
      .returning({ id: a2aConnections.id });
    await db
      .delete(a2aOutbox)
      .where(
        and(
          eq(a2aOutbox.connectionId, row.id),
          eq(a2aOutbox.kind, "pair_activate")
        )
      );
    if (activated) {
      await record({
        actor: peerActor(row),
        agentId: row.localAgentId,
        payload: { connectionId: row.id },
        type: "a2a.connection_activated",
        workspaceId: row.workspaceId,
      });
    }
  };

  /** AA.5 calls this when the outbox delivered the activation. */
  const activationDelivered = async (
    principal: Principal,
    connectionId: string
  ): Promise<void> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(APPROVE_ACTION);
    }
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(eq(a2aConnections.id, connectionId))
      .limit(1);
    if (row) {
      await markActive(row);
    }
  };

  /**
   * AA.5 calls this when the outbox gave up on an activation for good (the
   * joiner answered 404 or 401). The row ends instead of waiting for ever.
   */
  const activationAbandoned = async (
    principal: Principal,
    connectionId: string
  ): Promise<void> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(APPROVE_ACTION);
    }
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(eq(a2aConnections.id, connectionId))
      .limit(1);
    if (row?.status === "activating") {
      await endConnection(row, { actor: SYSTEM_ACTOR, notify: false });
    }
  };

  /** A person turns down a connection that waits for them. Nothing the peer holds works afterwards. */
  const decline = async (
    principal: Principal,
    connectionId: string
  ): Promise<ConnectionSummary> => {
    const user = requireSession(principal, DECLINE_ACTION);
    authorize(user, DECLINE_ACTION, {
      id: connectionId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const row = await requireRow(connectionId, user.workspaceId);
    const declined = await db
      .update(a2aConnections)
      .set({
        inboundTokenHash: null,
        inviteTokenHash: null,
        outboundCredential: null,
        status: "declined",
      })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "needs_approval")
        )
      )
      .returning({ id: a2aConnections.id });
    if (declined.length === 0) {
      throw new ServiceError(
        "conflict",
        "Connection is not waiting for approval"
      );
    }
    await queueNotice(row, "pair_decline", "/pair/decline");
    await record({
      actor: actorOf(user),
      agentId: row.localAgentId,
      payload: { connectionId: row.id },
      type: "a2a.connection_declined",
      workspaceId: row.workspaceId,
    });
    // A declined re-approval of an outside agent may have tasks to end.
    await fireRevoked({
      agentId: row.localAgentId,
      connectionId: row.id,
      peerKind: row.peerKind,
      workspaceId: row.workspaceId,
    });
    return await requireSummary(row.id, user.workspaceId);
  };

  // ---------------------------------------------------------------------
  // Harbourmaster to Harbourmaster: the joiner

  /**
   * Bob pastes the invite link and picks his agent. Our server calls the
   * inviter through the transport with a new token that lets the inviter's agent
   * call ours. The row waits for the inviter's approval (`awaiting_peer`).
   */
  const joinWithLink = async (
    principal: Principal,
    input: JoinWithLinkInput
  ): Promise<{ checkCode: string; connection: ConnectionSummary }> => {
    const user = requireSession(principal, JOIN_ACTION);
    const { agentId, link } = joinWithLinkInputSchema.parse(input);
    authorize(user, JOIN_ACTION, {
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const base = requireBase();
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, JOIN_ACTION);
    const card = await requirePublished(agentId);
    const parsed = parseInviteLink(link);
    if (!parsed) {
      throw new ServiceError("invalid", "That is not an invite link");
    }
    if (!transport) {
      throw new ServiceError("invalid", "Joining by link is not set up here");
    }
    const minted = await hashedToken(ACCESS_TOKEN_PREFIX);
    const answer = pairJoinResultSchema.parse(
      await transport.join({
        body: {
          agentName: agent.name,
          cardUrl: cardUrlOf(base, card.publicId),
          orgName: await workspaceName(user.workspaceId),
          token: minted.token,
        },
        inviteToken: parsed.inviteToken,
        origin: parsed.origin,
      })
    );
    // The inviter answers for itself. A card on another origin would borrow the
    // identity of an agent whose host never spoke to us.
    if (new URL(answer.cardUrl).origin !== parsed.origin) {
      throw new ServiceError(
        "invalid",
        "The inviter named an agent on a different host than the invite link"
      );
    }
    const peer = await vetPeer(
      answer.cardUrl,
      answer.orgName,
      user.workspaceId
    );
    await refuseDuplicate(agentId, answer.cardUrl);
    const code = await checkCode(parsed.inviteToken, minted.token);
    const id = `con_${ulid(clock.now().getTime())}`;
    await db.insert(a2aConnections).values({
      checkCode: code,
      createdAt: nowIso(),
      createdBy: user.userId,
      id,
      inboundTokenHash: minted.hash,
      inboundTokenPrefix: tokenHint(minted.token),
      localAgentId: agentId,
      peerCardUrl: answer.cardUrl,
      peerKind: "harbourmaster",
      peerLabel: answer.agentName,
      peerOrg: peer.org,
      peerOrigin: peer.origin,
      slug: await freeSlug(user.workspaceId, answer.agentName),
      status: "awaiting_peer",
      workspaceId: user.workspaceId,
    });
    await record({
      actor: actorOf(user),
      agentId,
      payload: { connectionId: id, peerOrigin: peer.origin },
      type: "a2a.connection_created",
      workspaceId: user.workspaceId,
    });
    return {
      checkCode: code,
      connection: await requireSummary(id, user.workspaceId),
    };
  };

  /** The row an incoming bearer token names as our inbound token, in one of `statuses`. */
  const rowByInboundToken = async (
    token: string,
    statuses: readonly A2aConnectionStatus[]
  ): Promise<ConnectionRow> => {
    const [row] = await db
      .select()
      .from(a2aConnections)
      .where(
        and(
          eq(a2aConnections.inboundTokenHash, await hashToken(token)),
          eq(a2aConnections.peerKind, "harbourmaster"),
          inArray(a2aConnections.status, [...statuses])
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Connection not found");
    }
    return row;
  };

  /**
   * The inviter's activation call, with the token the joiner issued as bearer.
   * Answering on that origin with that token is what proves the host is the
   * joiner's. The token it brings is the credential we present from now on.
   */
  const activate = async (
    bearer: string,
    input: PairActivateBody
  ): Promise<void> => {
    const row = await rowByInboundToken(bearer, ["awaiting_peer", "active"]);
    const body = pairActivateBodySchema.parse(input);
    if (row.status === "active") {
      // A retry after a lost answer brings the same token and changes nothing.
      const held = row.outboundCredential
        ? await unseal(credentialBinding(row), row.outboundCredential)
        : "";
      if (
        !constantTimeEqual(
          new TextEncoder().encode(held),
          new TextEncoder().encode(body.token)
        )
      ) {
        throw new ServiceError(
          "conflict",
          "Connection is not waiting for activation"
        );
      }
      return;
    }
    const activated = await db
      .update(a2aConnections)
      .set({
        approvedAt: nowIso(),
        outboundCredential: await seal(credentialBinding(row), body.token),
        outboundScheme: schemeLabel({ kind: "bearer" }),
        status: "active",
      })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "awaiting_peer")
        )
      )
      .returning({ id: a2aConnections.id });
    if (activated.length === 0) {
      throw new ServiceError(
        "conflict",
        "Connection is not waiting for activation"
      );
    }
    await record({
      actor: peerActor(row),
      agentId: row.localAgentId,
      payload: { connectionId: row.id },
      type: "a2a.connection_activated",
      workspaceId: row.workspaceId,
    });
  };

  /** The inviter turned the connection down. Our token for it stops working. */
  const declined = async (bearer: string): Promise<void> => {
    const row = await rowByInboundToken(bearer, ["awaiting_peer"]);
    const done = await db
      .update(a2aConnections)
      .set({ inboundTokenHash: null, status: "declined" })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "awaiting_peer")
        )
      )
      .returning({ id: a2aConnections.id });
    if (done.length > 0) {
      await record({
        actor: peerActor(row),
        agentId: row.localAgentId,
        payload: { connectionId: row.id },
        type: "a2a.connection_declined",
        workspaceId: row.workspaceId,
      });
    }
  };

  // ---------------------------------------------------------------------
  // Outside clients and outside agents

  /** Gives an outside client an access key for one published agent. Creating the row is the approval. */
  const createAccessKey = async (
    principal: Principal,
    input: AccessKeyInput
  ): Promise<{
    cardUrl: string;
    connection: ConnectionSummary;
    token: string;
  }> => {
    const user = requireSession(principal, KEY_ACTION);
    const { agentId, label } = accessKeyInputSchema.parse(input);
    authorize(user, KEY_ACTION, {
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    requireBase();
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, KEY_ACTION);
    const card = await requirePublished(agentId);
    const minted = await hashedToken(ACCESS_TOKEN_PREFIX);
    const id = `con_${ulid(clock.now().getTime())}`;
    const now = nowIso();
    await db.insert(a2aConnections).values({
      approvedAt: now,
      approvedBy: user.userId,
      createdAt: now,
      createdBy: user.userId,
      id,
      inboundTokenHash: minted.hash,
      inboundTokenPrefix: tokenHint(minted.token),
      localAgentId: agentId,
      peerKind: "a2a_inbound",
      peerLabel: label,
      slug: await freeSlug(user.workspaceId, label),
      status: "active",
      workspaceId: user.workspaceId,
    });
    await record({
      actor: actorOf(user),
      agentId,
      payload: {
        connectionId: id,
        peerKind: "a2a_inbound",
        tokenPrefix: tokenHint(minted.token),
      },
      type: "a2a.connection_created",
      workspaceId: user.workspaceId,
    });
    return {
      cardUrl: cardUrlOf(publicBaseUrl, card.publicId),
      connection: await requireSummary(id, user.workspaceId),
      token: minted.token,
    };
  };

  const fetchPeerCard = async (cardUrl: string) => {
    if (!fetchCard) {
      throw new ServiceError(
        "invalid",
        "Calling outside agents is not set up here"
      );
    }
    const parsed = agentCardSchema.safeParse(await fetchCard(cardUrl));
    if (!parsed.success) {
      throw new ServiceError("invalid", "That is not a valid agent card");
    }
    return parsed.data;
  };

  /** The credential text to seal for `scheme`, or a refusal when the person gave the wrong kind. */
  const credentialText = (
    scheme: OutboundScheme,
    credential: AddOutboundInput["credential"]
  ): string | null => {
    if (scheme.kind === "none") {
      return null;
    }
    if (scheme.kind === "oauth2_client_credentials") {
      const parsed = oauthCredentialSchema.safeParse(credential);
      if (!parsed.success) {
        throw new ServiceError(
          "invalid",
          "This agent wants an OAuth client id and secret"
        );
      }
      return JSON.stringify({
        ...parsed.data,
        scopes: scheme.scopes,
        tokenUrl: scheme.tokenUrl,
      });
    }
    if (typeof credential !== "string") {
      throw new ServiceError("invalid", "This agent wants a credential");
    }
    return credential;
  };

  /**
   * Adds an outside A2A agent we call. The card is fetched (injected), its
   * interface origin is the one the person approves, and the credential is
   * stored encrypted. Only the schemes the design lists are accepted.
   */
  const addOutbound = async (
    principal: Principal,
    input: AddOutboundInput
  ): Promise<ConnectionSummary> => {
    const user = requireSession(principal, OUTBOUND_ACTION);
    const { agentId, cardUrl, credential, label } =
      addOutboundInputSchema.parse(input);
    authorize(user, OUTBOUND_ACTION, {
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, OUTBOUND_ACTION);
    vetUrl(cardUrl);
    await refuseDuplicate(agentId, cardUrl);
    const card = await fetchPeerCard(cardUrl);
    const peerInterface = chooseInterface(card);
    if (!peerInterface) {
      throw new ServiceError(
        "invalid",
        "That agent offers no JSON-RPC or HTTP+JSON interface"
      );
    }
    vetUrl(peerInterface.url);
    const choice = chooseOutboundScheme(card);
    if (!choice.ok) {
      throw new ServiceError(
        "invalid",
        `That agent wants ${choice.wanted}, which Harbourmaster does not support`
      );
    }
    if (choice.scheme.kind === "oauth2_client_credentials") {
      // The client secret goes to this URL, so it passes the guard too.
      vetUrl(choice.scheme.tokenUrl);
    }
    const secret = credentialText(choice.scheme, credential);
    const id = `con_${ulid(clock.now().getTime())}`;
    const now = nowIso();
    const name = label ?? card.name;
    await db.insert(a2aConnections).values({
      approvedAt: now,
      approvedBy: user.userId,
      createdAt: now,
      createdBy: user.userId,
      id,
      localAgentId: agentId,
      outboundCredential:
        secret === null
          ? null
          : await seal(
              credentialBinding({ id, workspaceId: user.workspaceId }),
              secret
            ),
      outboundScheme: schemeLabel(choice.scheme),
      peerCard: JSON.stringify(card),
      peerCardFetchedAt: now,
      peerCardUrl: cardUrl,
      peerKind: "a2a_outbound",
      peerLabel: name,
      peerOrg: card.provider?.organization ?? null,
      peerOrigin: peerInterface.origin,
      slug: await freeSlug(user.workspaceId, name),
      status: "active",
      workspaceId: user.workspaceId,
    });
    await record({
      actor: actorOf(user),
      agentId,
      payload: {
        connectionId: id,
        peerKind: "a2a_outbound",
        peerOrigin: peerInterface.origin,
      },
      type: "a2a.connection_created",
      workspaceId: user.workspaceId,
    });
    return await requireSummary(id, user.workspaceId);
  };

  /**
   * What an outside agent's card says, for a person to look at before they
   * give it a credential. Creates nothing. Every field comes from the peer, so
   * the page shows it as plain text.
   */
  const previewCard = async (
    principal: Principal,
    input: PreviewCardInput
  ): Promise<CardPreview> => {
    const user = requireSession(principal, OUTBOUND_ACTION);
    const { agentId, cardUrl } = previewCardInputSchema.parse(input);
    authorize(user, OUTBOUND_ACTION, {
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, OUTBOUND_ACTION);
    vetUrl(cardUrl);
    await refuseDuplicate(agentId, cardUrl);
    const card = await fetchPeerCard(cardUrl);
    const peerInterface = chooseInterface(card);
    if (!peerInterface) {
      throw new ServiceError(
        "invalid",
        "That agent offers no JSON-RPC or HTTP+JSON interface"
      );
    }
    vetUrl(peerInterface.url);
    const choice = chooseOutboundScheme(card);
    if (!choice.ok) {
      throw new ServiceError(
        "invalid",
        `That agent wants ${choice.wanted}, which Harbourmaster does not support`
      );
    }
    return {
      description: card.description,
      host: new URL(peerInterface.url).host,
      name: card.name,
      org: card.provider?.organization ?? null,
      scheme: choice.scheme.kind,
      skills: card.skills.map((skill) => ({
        description: skill.description,
        name: skill.name,
      })),
    };
  };

  /** The live outside-agent connection a refresh acts on, with its card URL. */
  const refreshable = async (
    actor: SessionUser | { kind: "system" },
    connectionId: string
  ): Promise<ConnectionRow & { peerCardUrl: string }> => {
    let found: ConnectionRow | null | undefined;
    if (actor.kind === "user") {
      authorize(actor, REFRESH_ACTION, {
        id: connectionId,
        kind: CONNECTION_KIND,
        workspaceId: actor.workspaceId,
      });
      found = await requireRow(connectionId, actor.workspaceId);
    } else {
      [found] = await db
        .select()
        .from(a2aConnections)
        .where(eq(a2aConnections.id, connectionId))
        .limit(1);
    }
    if (
      found?.peerKind !== "a2a_outbound" ||
      !found.peerCardUrl ||
      ENDED.includes(found.status)
    ) {
      throw new ServiceError("not_found", "Connection not found");
    }
    return { ...found, peerCardUrl: found.peerCardUrl };
  };

  /**
   * Fetches the card of an outside agent again. When its interface moved to
   * another origin the connection goes back to `needs_approval`, and the
   * credential stays unsent until a person approves the new origin. A person
   * or the minute tick may call this: it can only narrow access.
   */
  const refreshCard = async (
    principal: Principal,
    connectionId: string
  ): Promise<ConnectionSummary> => {
    const actor =
      principal.kind === "system"
        ? principal
        : requireSession(principal, REFRESH_ACTION);
    const found = await refreshable(actor, connectionId);
    const card = await fetchPeerCard(found.peerCardUrl);
    const { label, movedAgain, needsPerson, origin } = compareCard(found, card);
    const flips = found.status === "active" && needsPerson;
    // One statement, so a stored card never gets ahead of the flip that goes
    // with it, and `returning` says whether this call's write landed. It only
    // matches the status this call read, so a revoke, an approval or another
    // refresh that landed while the card was fetched keeps what it decided, and
    // this call then logs nothing.
    const landed = await db
      .update(a2aConnections)
      .set({
        peerCard: JSON.stringify(card),
        peerCardFetchedAt: nowIso(),
        status: flips ? "needs_approval" : found.status,
      })
      .where(
        and(
          eq(a2aConnections.id, found.id),
          eq(a2aConnections.status, found.status)
        )
      )
      .returning({ id: a2aConnections.id });
    const moved =
      landed.length > 0 &&
      (flips || (found.status === "needs_approval" && movedAgain));
    if (moved) {
      await record({
        actor: actorOf(actor),
        agentId: found.localAgentId,
        payload: {
          connectionId: found.id,
          fromOrigin: found.peerOrigin,
          fromTokenUrl: tokenUrlOfLabel(found.outboundScheme),
          reason: reasonOf(needsPerson, origin !== found.peerOrigin),
          toOrigin: origin,
          toTokenUrl: tokenUrlOfLabel(label),
        },
        type: "a2a.connection_reapproval_needed",
        workspaceId: found.workspaceId,
      });
    }
    return await requireSummary(found.id, found.workspaceId);
  };

  /** The sealed OAuth credential, or null when it cannot be unsealed or read. */
  const readOauthCredential = async (row: ConnectionRow) => {
    if (!row.outboundCredential) {
      return null;
    }
    try {
      const plain = await unseal(
        credentialBinding(row),
        row.outboundCredential
      );
      const parsed = storedOauthSchema.safeParse(JSON.parse(plain));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  /**
   * The sealed OAuth credential with the card's current token URL and scopes.
   * The person approved this card, so the client secret may go to its token
   * URL, once that URL passes the guard.
   */
  const resealOauth = async (
    row: ConnectionRow,
    scheme: Extract<OutboundScheme, { kind: "oauth2_client_credentials" }>
  ): Promise<string> => {
    vetUrl(scheme.tokenUrl);
    const stored = await readOauthCredential(row);
    if (!stored) {
      throw new ServiceError(
        "conflict",
        "The stored credential cannot be read. Remove the agent and add it again."
      );
    }
    return await seal(
      credentialBinding(row),
      JSON.stringify({
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        scopes: scheme.scopes,
        tokenUrl: scheme.tokenUrl,
      })
    );
  };

  /** Refuses an approval for a destination other than the row's. The person must look again. */
  const refuseUnseen = (
    seen: { origin: string; tokenUrl: string | null },
    row: { origin: string | null; tokenUrl: string | null }
  ): void => {
    if (seen.origin !== row.origin || seen.tokenUrl !== row.tokenUrl) {
      throw new ServiceError(
        "conflict",
        "The destination changed since you looked. Review it and approve again."
      );
    }
  };

  /**
   * A person approves the destination a refreshed card now names: its
   * interface origin and, for OAuth, its token URL. The caller sends what it
   * showed, and a card that moved since is refused. The update also matches
   * the stored card exactly, so a refresh that lands between the check and the
   * write cannot slip another destination in.
   */
  const approveNewOrigin = async (
    user: SessionUser,
    row: ConnectionRow,
    seen: { origin: string; tokenUrl: string | null }
  ): Promise<ConnectionSummary> => {
    const card = parseStoredCard(row.peerCard);
    const peerInterface = card ? chooseInterface(card) : null;
    if (!(card && peerInterface)) {
      throw new ServiceError(
        "conflict",
        "The agent's card has no usable interface"
      );
    }
    vetUrl(peerInterface.url);
    const scheme = chooseOutboundScheme(card);
    if (
      !scheme.ok ||
      schemeKindOfLabel(schemeLabel(scheme.scheme)) !==
        schemeKindOfLabel(row.outboundScheme)
    ) {
      // The stored credential is for the old scheme. Adding the agent again takes the right one.
      throw new ServiceError(
        "conflict",
        "The agent now wants a different kind of credential. Remove it and add it again."
      );
    }
    const tokenUrl =
      scheme.scheme.kind === "oauth2_client_credentials"
        ? scheme.scheme.tokenUrl
        : null;
    refuseUnseen(seen, { origin: peerInterface.origin, tokenUrl });
    // Only now, with the destination approved, does the client secret move to
    // the new token URL.
    const outboundCredential =
      scheme.scheme.kind === "oauth2_client_credentials"
        ? await resealOauth(row, scheme.scheme)
        : row.outboundCredential;
    const approved = await db
      .update(a2aConnections)
      .set({
        approvedAt: nowIso(),
        approvedBy: user.userId,
        outboundCredential,
        outboundScheme: schemeLabel(scheme.scheme),
        peerOrigin: peerInterface.origin,
        status: "active",
      })
      .where(
        and(
          eq(a2aConnections.id, row.id),
          eq(a2aConnections.status, "needs_approval"),
          row.peerCard === null
            ? isNull(a2aConnections.peerCard)
            : eq(a2aConnections.peerCard, row.peerCard)
        )
      )
      .returning({ id: a2aConnections.id });
    if (approved.length === 0) {
      throw new ServiceError(
        "conflict",
        "The destination changed since you looked. Review it and approve again."
      );
    }
    await record({
      actor: actorOf(user),
      agentId: row.localAgentId,
      payload: {
        connectionId: row.id,
        peerOrigin: peerInterface.origin,
        tokenUrl,
      },
      type: "a2a.connection_approved",
      workspaceId: row.workspaceId,
    });
    return await requireSummary(row.id, row.workspaceId);
  };

  // ---------------------------------------------------------------------
  // Policies and withdrawing

  /**
   * Changes the settings on a connection. Widening (`auto`, `agent_rules`, a
   * higher hourly limit, or anything from `off` up) needs an org admin or the
   * agent's owner. Narrowing, `inbound_policy = off` among it, needs only a
   * person on a session, so access can be cut in a hurry.
   */
  const setPolicies = async (
    principal: Principal,
    input: PoliciesInput
  ): Promise<ConnectionSummary> => {
    const user = requireSession(principal, POLICIES_ACTION);
    const change = policiesInputSchema.parse(input);
    authorize(user, POLICIES_ACTION, {
      id: change.connectionId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const row = await requireRow(change.connectionId, user.workspaceId);
    if (ENDED.includes(row.status)) {
      throw new ServiceError("conflict", "The connection has ended");
    }
    const widens =
      (change.inboundPolicy !== undefined &&
        WIDTH.inbound[change.inboundPolicy] >
          WIDTH.inbound[row.inboundPolicy]) ||
      (change.outboundPolicy !== undefined &&
        WIDTH.outbound[change.outboundPolicy] >
          WIDTH.outbound[row.outboundPolicy]) ||
      (change.toolPolicy !== undefined &&
        WIDTH.tool[change.toolPolicy] > WIDTH.tool[row.toolPolicy]) ||
      (change.hourlyLimit !== undefined &&
        change.hourlyLimit > row.hourlyLimit);
    if (widens) {
      const agent = await requireActiveAgent(
        row.localAgentId,
        user.workspaceId
      );
      requireAdminOrOwner(user, agent, POLICIES_ACTION);
    }
    const next = {
      hourlyLimit: change.hourlyLimit ?? row.hourlyLimit,
      inboundPolicy: change.inboundPolicy ?? row.inboundPolicy,
      outboundPolicy: change.outboundPolicy ?? row.outboundPolicy,
      toolPolicy: change.toolPolicy ?? row.toolPolicy,
    };
    const changed = Object.entries(next)
      .filter(([key, value]) => row[key as keyof typeof next] !== value)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    if (changed === "") {
      return await requireSummary(row.id, user.workspaceId);
    }
    const updated = await db
      .update(a2aConnections)
      .set(next)
      .where(
        and(
          eq(a2aConnections.id, row.id),
          notInArray(a2aConnections.status, [...ENDED])
        )
      )
      .returning({ id: a2aConnections.id });
    if (updated.length === 0) {
      throw new ServiceError("conflict", "The connection has ended");
    }
    await record({
      actor: actorOf(user),
      agentId: row.localAgentId,
      payload: { changed, connectionId: row.id, widened: widens },
      type: "a2a.policy_changed",
      workspaceId: row.workspaceId,
    });
    return await requireSummary(row.id, user.workspaceId);
  };

  /**
   * Ends a connection. Any person on a session may: cutting access should not
   * need the right person awake. The token fails on its next use because
   * `authenticate` re-reads the row. A Harbourmaster peer is told through the
   * outbox, best effort. A second revoke changes nothing.
   */
  const revoke = async (
    principal: Principal,
    connectionId: string
  ): Promise<ConnectionSummary> => {
    const user = requireSession(principal, REVOKE_ACTION);
    authorize(user, REVOKE_ACTION, {
      id: connectionId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const row = await requireRow(connectionId, user.workspaceId);
    if (row.status === "declined") {
      throw new ServiceError("conflict", "The connection was declined");
    }
    await endConnection(row, { actor: actorOf(user), notify: true });
    return await requireSummary(row.id, user.workspaceId);
  };

  /**
   * The peer's notice that it revoked, with the credential it holds for us as
   * bearer. The access ended on its side already, so this only records it. We
   * send nothing back.
   */
  const peerRevoked = async (bearer: string): Promise<void> => {
    const row = await rowByInboundToken(bearer, [
      "awaiting_peer",
      "activating",
      "active",
      "revoked",
    ]);
    await endConnection(row, { actor: peerActor(row), notify: false });
  };

  // ---------------------------------------------------------------------
  // Authenticating a peer

  /**
   * The `peer` principal for an `hm_a2a_` token, or null. It re-reads the
   * connection on every call and caches nothing, so a revoke takes effect on the
   * next request. The connection must be `active`, and its agent published and
   * active. This is not part of `createPrincipalResolver`, so the token works
   * only on the `/a2a` routes.
   */
  const authenticate = async (token: string): Promise<PeerPrincipal | null> => {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) {
      return null;
    }
    const [row] = await db
      .select({
        agentId: a2aConnections.localAgentId,
        id: a2aConnections.id,
        workspaceId: a2aConnections.workspaceId,
      })
      .from(a2aConnections)
      .innerJoin(
        a2aAgentCards,
        eq(a2aAgentCards.agentId, a2aConnections.localAgentId)
      )
      .innerJoin(agents, eq(agents.id, a2aConnections.localAgentId))
      .where(
        and(
          eq(a2aConnections.inboundTokenHash, await hashToken(token)),
          eq(a2aConnections.status, "active"),
          isNull(a2aAgentCards.unpublishedAt),
          eq(agents.status, "active")
        )
      )
      .limit(1);
    return row
      ? {
          agentId: row.agentId,
          connectionId: row.id,
          kind: "peer",
          workspaceId: row.workspaceId,
        }
      : null;
  };

  // ---------------------------------------------------------------------
  // Reads

  /** The workspace's connections, newest first, ended ones included. */
  const list = async (
    principal: Principal,
    input: ListConnectionsInput = {}
  ): Promise<ConnectionSummary[]> => {
    const reader = requireReader(principal, READ_ACTION);
    const { agentId } = listInputSchema.parse(input);
    authorize(reader, READ_ACTION, {
      kind: CONNECTION_KIND,
      workspaceId: reader.workspaceId,
    });
    const rows = await db
      .select(summaryColumns)
      .from(a2aConnections)
      .innerJoin(agents, eq(agents.id, a2aConnections.localAgentId))
      .where(
        and(
          eq(a2aConnections.workspaceId, reader.workspaceId),
          agentId === undefined
            ? undefined
            : eq(a2aConnections.localAgentId, agentId)
        )
      )
      .orderBy(desc(a2aConnections.createdAt), asc(a2aConnections.id));
    return rows.map(toSummary);
  };

  const get = async (
    principal: Principal,
    connectionId: string
  ): Promise<ConnectionSummary> => {
    const reader = requireReader(principal, READ_ACTION);
    authorize(reader, READ_ACTION, {
      id: connectionId,
      kind: CONNECTION_KIND,
      workspaceId: reader.workspaceId,
    });
    return await requireSummary(connectionId, reader.workspaceId);
  };

  /** An agent's publication, or null when it never was published. */
  const getPublished = async (
    principal: Principal,
    agentId: string
  ): Promise<PublishedCard | null> => {
    const reader = requireReader(principal, READ_ACTION);
    authorize(reader, READ_ACTION, {
      id: agentId,
      kind: CONNECTION_KIND,
      workspaceId: reader.workspaceId,
    });
    const card = await findCard(agentId);
    return card && card.workspaceId === reader.workspaceId
      ? publishedCardOf(card)
      : null;
  };

  /** Registers a function that runs after a connection is revoked. */
  const onRevoked = (listener: RevokedListener): void => {
    revokedListeners.push(listener);
  };

  return {
    activate,
    activationAbandoned,
    activationDelivered,
    addOutbound,
    approve,
    authenticate,
    createAccessKey,
    createInvite,
    decline,
    declined,
    get,
    getPublished,
    join,
    joinWithLink,
    list,
    onRevoked,
    peerRevoked,
    previewCard,
    publicCard,
    publish,
    refreshCard,
    revoke,
    setPolicies,
    unpublish,
  };
};

export type ConnectionsService = ReturnType<typeof createConnectionsService>;
