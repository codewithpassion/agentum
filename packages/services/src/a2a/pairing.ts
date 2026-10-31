/**
 * Pairing by code, for an outside client that has no key yet. The spec is the
 * section "Pairing code, for an outside client we haven't given a key" of
 * docs/v3/agent-connections.md, and the limits are the ones in Hermes's
 * `gateway/pairing.py`.
 *
 * The client calls with a token we don't know. With "Accept pairing requests"
 * on, `requestPairing` stores the hash of that token and hands back an
 * 8-character code. The code reaches the agent's owner by the client's own
 * means, and the owner types it in with `approvePairingCode`, which turns the
 * token into the inbound token of a new `a2a_inbound` connection.
 *
 * Neither the token nor the code is stored. Both are SHA-256 hashes. The code
 * is an HMAC of the request id and the token, so asking again with the same
 * token returns the same code without keeping it. Nothing here writes a token,
 * a code or any text of the client's message to an event.
 */

import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  a2aAgentCards,
  a2aConnections,
  a2aPairingRequests,
} from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import type { EventActorKind, EventType } from "@repo/db/shared";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import type { AgentRecord } from "../agents.ts";
import { authorize } from "../authz.ts";
import { hashToken } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import {
  CONNECTION_KIND,
  requireAdminOrOwner,
  requireSession,
  type SessionUser,
} from "./access.ts";
import type { ConnectionSummary, PublishedCard } from "./connections.ts";
import { pairingRequestCode } from "./pairing-code.ts";

const HOUR_MS = 60 * 60 * 1000;
/** How long a request waits for its code to be typed in. */
export const PAIRING_REQUEST_TTL_MS = HOUR_MS;
/** Pending requests per agent. A fourth is refused until one expires or is approved. */
export const PAIRING_MAX_PENDING = 3;
/** Wrong codes in a row that lock the agent's pairing. */
export const PAIRING_MAX_FAILURES = 5;
/** How long the lock lasts. */
export const PAIRING_LOCKOUT_MS = HOUR_MS;
/** A token shorter than this is not a pairing request, whatever it says. */
export const PAIRING_TOKEN_MIN = 32;
/** Characters of the token's hash kept to tell connections apart in a list. Never the token itself. */
const TOKEN_HINT_LENGTH = 4;

export const PAIRING_SWITCH_ACTION = "a2a.pairing_switch";
export const PAIRING_APPROVE_ACTION = "a2a.pairing_approve";

const WRONG_CODE = "That code is not valid or has expired.";
const LOCKED = "Too many wrong codes. Pairing is locked for an hour.";

const idString = z.string().min(1).max(200);

export const setPairingOpenInputSchema = z.strictObject({
  agentId: idString,
  open: z.boolean(),
});
export type SetPairingOpenInput = z.input<typeof setPairingOpenInputSchema>;

export const approvePairingInputSchema = z.strictObject({
  agentId: idString,
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
});
export type ApprovePairingInput = z.input<typeof approvePairingInputSchema>;

/** An event as the connections service writes it. */
interface RecordInput {
  actor: { id: string; kind: EventActorKind };
  agentId: string;
  payload?: Record<string, string | number | boolean | null>;
  type: EventType;
  workspaceId: string;
}

/** What the closure of the connections service lends to pairing. */
export interface PairingOptions {
  actorOf: (principal: Principal) => { id: string; kind: EventActorKind };
  atomic: Atomic;
  clock: Clock;
  db: Database;
  freeSlug: (workspaceId: string, wanted: string) => Promise<string>;
  publishedCardOf: (card: typeof a2aAgentCards.$inferSelect) => PublishedCard;
  record: (input: RecordInput) => Promise<void>;
  requireActiveAgent: (
    agentId: string,
    workspaceId: string
  ) => Promise<AgentRecord>;
  requireSummary: (
    id: string,
    workspaceId: string
  ) => Promise<ConnectionSummary>;
  secretsKey: string | undefined;
}

/** What the log shows as the actor of a request nobody has signed in for. */
const REQUEST_ACTOR = { id: "pairing", kind: "system" } as const;

/** A code as typed: no spaces or dashes, upper case. */
const normalizeCode = (code: string): string =>
  code.replaceAll(/[\s-]/g, "").toUpperCase();

export const createPairing = ({
  actorOf,
  atomic,
  clock,
  db,
  freeSlug,
  publishedCardOf,
  record,
  requireActiveAgent,
  requireSummary,
  secretsKey,
}: PairingOptions) => {
  const nowIso = () => clock.now().toISOString();

  const requireKey = (): string => {
    if (!secretsKey) {
      throw new Error("Pairing needs secretsKey (SECRETS_KEY).");
    }
    return secretsKey;
  };

  const findCard = async (agentId: string, workspaceId: string) => {
    const [card] = await db
      .select()
      .from(a2aAgentCards)
      .where(
        and(
          eq(a2aAgentCards.agentId, agentId),
          eq(a2aAgentCards.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return card ?? null;
  };

  const requirePublishedCard = async (agentId: string, workspaceId: string) => {
    const card = await findCard(agentId, workspaceId);
    if (!card || card.unpublishedAt !== null) {
      throw new ServiceError("invalid", "Publish the agent first.");
    }
    return card;
  };

  /**
   * The agent a public id names, but only while a request may be made of it:
   * published, active, accepting pairing requests and not locked. Null is every
   * other case, and the route answers its normal 401. For the route: no principal.
   */
  const pairableAgent = async (publicId: string): Promise<string | null> => {
    if (!secretsKey) {
      return null;
    }
    const now = nowIso();
    const [row] = await db
      .select({ agentId: a2aAgentCards.agentId })
      .from(a2aAgentCards)
      .innerJoin(agents, eq(agents.id, a2aAgentCards.agentId))
      .where(
        and(
          eq(a2aAgentCards.publicId, publicId),
          isNull(a2aAgentCards.unpublishedAt),
          eq(a2aAgentCards.pairingOpen, true),
          or(
            isNull(a2aAgentCards.pairingLockedUntil),
            lte(a2aAgentCards.pairingLockedUntil, now)
          ),
          eq(agents.status, "active")
        )
      )
      .limit(1);
    return row?.agentId ?? null;
  };

  /** The code for a stored request and the token it was made with. */
  const codeOf = async (requestId: string, token: string): Promise<string> =>
    await pairingRequestCode(requireKey(), requestId, token);

  /**
   * An unknown client's request: the code to show it, or null when the request
   * is refused (a short token, pairing off or locked, a token that already
   * belongs to a connection, or three requests already waiting). A refusal
   * writes nothing. For the route: no principal. The route only asks for a
   * `SendMessage`, and never hands over the message.
   */
  const requestPairing = async (
    agentId: string,
    token: string
  ): Promise<string | null> => {
    if (token.length < PAIRING_TOKEN_MIN) {
      return null;
    }
    const [card] = await db
      .select({
        publicId: a2aAgentCards.publicId,
        workspaceId: a2aAgentCards.workspaceId,
      })
      .from(a2aAgentCards)
      .where(eq(a2aAgentCards.agentId, agentId))
      .limit(1);
    if (!card || (await pairableAgent(card.publicId)) !== agentId) {
      return null;
    }
    const tokenHash = await hashToken(token);
    const [taken] = await db
      .select({ id: a2aConnections.id })
      .from(a2aConnections)
      .where(eq(a2aConnections.inboundTokenHash, tokenHash))
      .limit(1);
    if (taken) {
      return null;
    }
    const now = nowIso();
    // An expired request must go before the token can ask again.
    await db
      .delete(a2aPairingRequests)
      .where(
        and(
          eq(a2aPairingRequests.agentId, agentId),
          lte(a2aPairingRequests.expiresAt, now)
        )
      );
    const pending = await db
      .select({
        id: a2aPairingRequests.id,
        tokenHash: a2aPairingRequests.tokenHash,
      })
      .from(a2aPairingRequests)
      .where(eq(a2aPairingRequests.agentId, agentId));
    const same = pending.find((row) => row.tokenHash === tokenHash);
    if (same) {
      return await codeOf(same.id, token);
    }
    if (pending.length >= PAIRING_MAX_PENDING) {
      return null;
    }
    const id = `prq_${ulid(clock.now().getTime())}`;
    const code = await codeOf(id, token);
    const codeHash = await hashToken(code);
    const expiresAt = new Date(
      clock.now().getTime() + PAIRING_REQUEST_TTL_MS
    ).toISOString();
    // One statement counts the pending requests and inserts, so requests that
    // arrive together can't pass the limit. A repeat of a token already waiting
    // is dropped by the unique index.
    await db.run(sql`
      insert into a2a_pairing_requests
        (id, workspace_id, agent_id, code_hash, token_hash, token_prefix, expires_at, created_at)
      select ${id}, ${card.workspaceId}, ${agentId}, ${codeHash}, ${tokenHash}, ${tokenHash.slice(0, TOKEN_HINT_LENGTH)}, ${expiresAt}, ${now}
      where (
        select count(*) from a2a_pairing_requests
        where agent_id = ${agentId} and expires_at > ${now}
      ) < ${PAIRING_MAX_PENDING}
      on conflict do nothing`);
    const [stored] = await db
      .select({ id: a2aPairingRequests.id })
      .from(a2aPairingRequests)
      .where(eq(a2aPairingRequests.id, id))
      .limit(1);
    if (!stored) {
      // Over the limit, or the same token asked at the same moment. In the
      // second case its row has the code.
      const [raced] = await db
        .select({ id: a2aPairingRequests.id })
        .from(a2aPairingRequests)
        .where(
          and(
            eq(a2aPairingRequests.agentId, agentId),
            eq(a2aPairingRequests.tokenHash, tokenHash)
          )
        )
        .limit(1);
      return raced ? await codeOf(raced.id, token) : null;
    }
    await record({
      actor: REQUEST_ACTOR,
      agentId,
      payload: { requestId: id },
      type: "a2a.pairing_requested",
      workspaceId: card.workspaceId,
    });
    return code;
  };

  /**
   * Turns "Accept pairing requests" on or off for a published agent. An org
   * admin or the agent's owner, on a browser session. Turning it off also drops
   * the requests still waiting, so a code handed out earlier stops working.
   */
  const setPairingOpen = async (
    principal: Principal,
    input: SetPairingOpenInput
  ): Promise<PublishedCard> => {
    const user = requireSession(principal, PAIRING_SWITCH_ACTION);
    const { agentId, open } = setPairingOpenInputSchema.parse(input);
    authorize(user, PAIRING_SWITCH_ACTION, {
      id: agentId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, PAIRING_SWITCH_ACTION);
    await requirePublishedCard(agentId, user.workspaceId);
    await atomic([
      db
        .update(a2aAgentCards)
        .set({ pairingOpen: open })
        .where(eq(a2aAgentCards.agentId, agentId)),
      ...(open
        ? []
        : [
            db
              .delete(a2aPairingRequests)
              .where(eq(a2aPairingRequests.agentId, agentId)),
          ]),
    ]);
    await record({
      actor: actorOf(user),
      agentId,
      payload: { open },
      type: "a2a.pairing_switched",
      workspaceId: user.workspaceId,
    });
    return publishedCardOf(
      await requirePublishedCard(agentId, user.workspaceId)
    );
  };

  /**
   * Counts a wrong code. In one statement, so two wrong codes at once both
   * count: the fifth sets the lock and starts the count again.
   */
  const failCode = async (
    agentId: string,
    user: SessionUser
  ): Promise<{ failures: number; locked: boolean }> => {
    const until = new Date(
      clock.now().getTime() + PAIRING_LOCKOUT_MS
    ).toISOString();
    const reached = sql`${a2aAgentCards.pairingFailures} + 1 >= ${PAIRING_MAX_FAILURES}`;
    const [row] = await db
      .update(a2aAgentCards)
      .set({
        pairingFailures: sql`case when ${reached} then 0 else ${a2aAgentCards.pairingFailures} + 1 end`,
        pairingLockedUntil: sql`case when ${reached} then ${until} else ${a2aAgentCards.pairingLockedUntil} end`,
      })
      .where(eq(a2aAgentCards.agentId, agentId))
      .returning({
        failures: a2aAgentCards.pairingFailures,
        lockedUntil: a2aAgentCards.pairingLockedUntil,
      });
    const locked = row?.lockedUntil === until;
    await record({
      actor: actorOf(user),
      agentId,
      payload: {
        failures: locked ? PAIRING_MAX_FAILURES : (row?.failures ?? 0),
      },
      type: "a2a.pairing_code_wrong",
      workspaceId: user.workspaceId,
    });
    if (locked) {
      await record({
        actor: actorOf(user),
        agentId,
        payload: { until },
        type: "a2a.pairing_locked",
        workspaceId: user.workspaceId,
      });
    }
    return { failures: row?.failures ?? 0, locked };
  };

  /**
   * The owner types the code the client was shown. A right code creates an
   * `a2a_inbound` connection under the default policies, with the client's
   * token as its inbound token, and deletes the request in the same write, so
   * a code works once. A wrong code counts toward the lock, and during the lock
   * even the right code is refused.
   */
  const approvePairingCode = async (
    principal: Principal,
    input: ApprovePairingInput
  ): Promise<ConnectionSummary> => {
    const user = requireSession(principal, PAIRING_APPROVE_ACTION);
    const { agentId, code, label } = approvePairingInputSchema.parse(input);
    authorize(user, PAIRING_APPROVE_ACTION, {
      id: agentId,
      kind: CONNECTION_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await requireActiveAgent(agentId, user.workspaceId);
    requireAdminOrOwner(user, agent, PAIRING_APPROVE_ACTION);
    const card = await requirePublishedCard(agentId, user.workspaceId);
    const now = nowIso();
    if (card.pairingLockedUntil !== null && card.pairingLockedUntil > now) {
      throw new ServiceError("conflict", LOCKED);
    }
    const [request] = await db
      .select()
      .from(a2aPairingRequests)
      .where(
        and(
          eq(a2aPairingRequests.agentId, agentId),
          eq(a2aPairingRequests.codeHash, await hashToken(normalizeCode(code))),
          gt(a2aPairingRequests.expiresAt, now)
        )
      )
      .limit(1);
    if (!request) {
      const { locked } = await failCode(agentId, user);
      throw new ServiceError("invalid", locked ? LOCKED : WRONG_CODE);
    }
    const [taken] = await db
      .select({ id: a2aConnections.id })
      .from(a2aConnections)
      .where(eq(a2aConnections.inboundTokenHash, request.tokenHash))
      .limit(1);
    if (taken) {
      await db
        .delete(a2aPairingRequests)
        .where(eq(a2aPairingRequests.id, request.id));
      throw new ServiceError(
        "conflict",
        "That token already belongs to another connection."
      );
    }
    const id = `con_${ulid(clock.now().getTime())}`;
    // One write. A second approval of the same code finds the request gone,
    // and one that raced past that fails on the unique token hash and undoes both.
    await atomic([
      db.insert(a2aConnections).values({
        approvedAt: now,
        approvedBy: user.userId,
        createdAt: now,
        createdBy: user.userId,
        id,
        inboundTokenHash: request.tokenHash,
        inboundTokenPrefix: request.tokenPrefix,
        localAgentId: agentId,
        peerKind: "a2a_inbound",
        peerLabel: label,
        slug: await freeSlug(user.workspaceId, label),
        status: "active",
        workspaceId: user.workspaceId,
      }),
      db
        .delete(a2aPairingRequests)
        .where(eq(a2aPairingRequests.id, request.id)),
      db
        .update(a2aAgentCards)
        .set({ pairingFailures: 0 })
        .where(eq(a2aAgentCards.agentId, agentId)),
    ]);
    await record({
      actor: actorOf(user),
      agentId,
      payload: { connectionId: id, requestId: request.id },
      type: "a2a.pairing_approved",
      workspaceId: user.workspaceId,
    });
    await record({
      actor: actorOf(user),
      agentId,
      payload: {
        connectionId: id,
        peerKind: "a2a_inbound",
        tokenPrefix: request.tokenPrefix,
      },
      type: "a2a.connection_created",
      workspaceId: user.workspaceId,
    });
    return await requireSummary(id, user.workspaceId);
  };

  return { approvePairingCode, pairableAgent, requestPairing, setPairingOpen };
};

export type PairingService = ReturnType<typeof createPairing>;
