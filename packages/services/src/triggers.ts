/**
 * HTTP triggers: a way to start one agent from outside with a per-trigger
 * bearer token (`ag_trg_`). A person makes, pauses and revokes triggers. The
 * secret is shown once, at creation, and the table keeps only its SHA-256. A
 * caller with the token calls `fire`, which starts a run through `startRun`
 * as the trigger itself: the run is on behalf of nobody.
 *
 * An agent's run may only propose a trigger for its own agent. It is stored
 * paused and marked as proposed, with no token at all: nobody holds a secret
 * for it, least of all the run. A person approves it (`approve`), which
 * mints the token and shows it once, or rejects it.
 */

import type { Database } from "@repo/db";
import { findMapTrigger } from "@repo/db/map";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { isPendingProposal, type TriggerKind } from "@repo/db/shared";
import { TRIGGER_TOKEN } from "@repo/protocol/token-prefixes";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import {
  createdByOf,
  proposalColumns,
  recordChange,
  requireApprover,
  requireOwnAgent,
  requireReader,
  requireWriter,
} from "./automation-access.ts";
import { hashedToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import {
  type Clock,
  INPUT_TEXT_MAX,
  type RunSummary,
  TERMINAL_STATUSES,
} from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import { WAIT_MAX_MS } from "./runs.ts";
import {
  bearerToken,
  findTriggerByToken,
  type Principal,
} from "./workspaces.ts";

/** The prefix new trigger tokens get. Check with `TRIGGER_TOKEN` from token-prefixes. */
export const TRIGGER_TOKEN_PREFIX = TRIGGER_TOKEN.issue;
/** Characters of the random part shown back, so triggers can be told apart. */
const HINT_LENGTH = 4;
/** The longest `requestId` a caller may send. It is stored with a prefix. */
export const REQUEST_ID_MAX = 128;

const TRIGGER_KIND = "trigger";

type MintedToken = Awaited<ReturnType<typeof hashedToken>>;

/** The start of a token kept next to its hash, so triggers can be told apart. */
const tokenHint = (token: string): string =>
  token.slice(0, TRIGGER_TOKEN_PREFIX.length + HINT_LENGTH);
const CREATE_ACTION = "triggers.create";
const LIST_ACTION = "triggers.list";
const REVOKE_ACTION = "triggers.revoke";
const ENABLE_ACTION = "triggers.setEnabled";
const APPROVE_ACTION = "triggers.approve";
const REJECT_ACTION = "triggers.reject";
const FIRE_ACTION = "triggers.fire";

export type TriggerPrincipal = Extract<Principal, { kind: "trigger" }>;

export const triggerCreateInputSchema = z.strictObject({
  agentId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
});
export type TriggerCreateInput = z.input<typeof triggerCreateInputSchema>;

export const triggerListInputSchema = z.strictObject({
  agentId: z.string().min(1).max(200).optional(),
});
export type TriggerListInput = z.input<typeof triggerListInputSchema>;

export const triggerSetEnabledInputSchema = z.strictObject({
  enabled: z.boolean(),
  triggerId: z.string().min(1).max(200),
});
export type TriggerSetEnabledInput = z.input<
  typeof triggerSetEnabledInputSchema
>;

/** The body of `POST /api/triggers/:id`. */
export const triggerFireInputSchema = z.strictObject({
  requestId: z.string().min(1).max(REQUEST_ID_MAX).optional(),
  text: z.string().min(1).max(INPUT_TEXT_MAX),
  waitMs: z.number().int().min(0).max(WAIT_MAX_MS).optional(),
});
export type TriggerFireInput = z.input<typeof triggerFireInputSchema>;

/** A trigger as a signed-in user may see it. Never carries the hash. */
export interface TriggerSummary {
  agentId: string;
  agentName: string;
  /** When a person approved a proposal. Null for one still waiting, and for one a person made. */
  approvedAt: string | null;
  createdAt: string;
  /** Set while the trigger is paused or waiting for approval. It cannot be fired. */
  disabledAt: string | null;
  id: string;
  kind: TriggerKind;
  lastFiredAt: string | null;
  name: string;
  /** Set when an agent's run proposed the trigger. */
  proposedByAgentId: string | null;
  proposedByRunId: string | null;
  revokedAt: string | null;
  /** Empty for a proposal that has no token yet. */
  tokenPrefix: string;
}

/** What creating or approving a trigger hands back. `secret` is the only copy, and null when there is none to show. */
export interface TriggerWithSecret {
  secret: string | null;
  trigger: TriggerSummary;
}

/**
 * What `fire` hands back. `finished` is true only when the caller asked to
 * wait and the run ended in time; the route answers 200 then, 202 otherwise.
 */
export interface FireResult {
  finished: boolean;
  run: RunSummary;
}

const summaryColumns = {
  agentId: triggers.agentId,
  agentName: agents.name,
  approvedAt: triggers.approvedAt,
  createdAt: triggers.createdAt,
  disabledAt: triggers.disabledAt,
  id: triggers.id,
  kind: triggers.kind,
  lastFiredAt: triggers.lastFiredAt,
  name: triggers.name,
  proposedByAgentId: triggers.proposedByAgentId,
  proposedByRunId: triggers.proposedByRunId,
  revokedAt: triggers.revokedAt,
  // App triggers and HTTP proposals have no token.
  tokenPrefix: sql<string>`coalesce(${triggers.tokenPrefix}, '')`,
};

export const createTriggersService = ({
  clock,
  db,
  events: eventsService,
  runs,
}: {
  clock: Clock;
  db: Database;
  events: EventsService;
  runs: RunsService;
}) => {
  /**
   * The trigger principal for `Authorization: Bearer ag_trg_...`, or null. A
   * revoked trigger, an unknown token and a workspace with no row are all
   * null.
   */
  const authenticate = async (
    authorization: string | null
  ): Promise<TriggerPrincipal | null> => {
    const token = bearerToken(authorization);
    if (!(token && TRIGGER_TOKEN.matches(token))) {
      return null;
    }
    const principal = await findTriggerByToken(db, token);
    if (!principal) {
      return null;
    }
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    return workspace ? principal : null;
  };

  const findSummary = async (
    triggerId: string,
    workspaceId: string
  ): Promise<TriggerSummary | null> => {
    const [row] = await db
      .select(summaryColumns)
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, workspaceId),
          inArray(triggers.kind, ["http", "app"])
        )
      )
      .limit(1);
    return row ?? null;
  };

  const requireSummary = async (triggerId: string, workspaceId: string) => {
    const summary = await findSummary(triggerId, workspaceId);
    if (!summary) {
      throw new ServiceError("not_found", "Trigger not found");
    }
    return summary;
  };

  /** A trigger that is live to act on: found, and not revoked. */
  const requireLive = async (
    triggerId: string,
    workspaceId: string,
    movable = false
  ) => {
    const summary = movable
      ? await findMapTrigger(db, workspaceId, triggerId)
      : await requireSummary(triggerId, workspaceId);
    if (!summary) {
      throw new ServiceError("not_found", "Trigger not found");
    }
    if (summary.revokedAt !== null) {
      throw new ServiceError("not_found", "Trigger not found");
    }
    return summary;
  };

  const reassign = async (
    principal: Principal,
    triggerId: string,
    agentId: string
  ): Promise<void> => {
    // Moving wires is a person's edit; a run cannot move its proposal to another agent.
    const user = requireApprover(principal, "triggers.reassign");
    authorize(user, "triggers.reassign", {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await requireLive(triggerId, user.workspaceId, true);
    if (isPendingProposal(current)) {
      throw new ServiceError(
        "conflict",
        "Trigger is a proposal; approve it first"
      );
    }
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: user.workspaceId,
    });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    await db
      .update(triggers)
      .set({ agentId })
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.revokedAt)
        )
      );
  };

  /**
   * A new HTTP trigger for one agent. The returned `secret` is the only copy.
   * From a run it is a proposal: stored paused, for the run's own agent only,
   * with no token and so no secret to hand back.
   */
  const create = async (
    principal: Principal,
    input: TriggerCreateInput
  ): Promise<TriggerWithSecret> => {
    const actor = requireWriter(principal, CREATE_ACTION);
    const { agentId, name } = triggerCreateInputSchema.parse(input);
    authorize(actor, CREATE_ACTION, {
      kind: TRIGGER_KIND,
      workspaceId: actor.workspaceId,
    });
    requireOwnAgent(actor, agentId, CREATE_ACTION);
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: actor.workspaceId,
    });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    const now = clock.now();
    const proposed = actor.kind === "run";
    const minted: MintedToken | null = proposed
      ? null
      : await hashedToken(TRIGGER_TOKEN_PREFIX);
    const id = `trg_${ulid(now.getTime())}`;
    await db.insert(triggers).values({
      agentId: agent.id,
      createdAt: now.toISOString(),
      createdBy: createdByOf(actor),
      disabledAt: proposed ? now.toISOString() : null,
      id,
      kind: "http",
      name,
      tokenHash: minted?.hash ?? null,
      tokenPrefix: minted ? tokenHint(minted.token) : null,
      workspaceId: actor.workspaceId,
      ...proposalColumns(actor),
    });
    await recordChange(eventsService, actor, {
      agentId: agent.id,
      change: "created",
      kind: "http",
      name,
      proposed,
      triggerId: id,
      workspaceId: actor.workspaceId,
    });
    return {
      secret: minted?.token ?? null,
      trigger: await requireSummary(id, actor.workspaceId),
    };
  };

  /** The workspace's triggers, newest first, revoked ones included. A run sees its own agent's. */
  const list = async (
    principal: Principal,
    input: TriggerListInput = {}
  ): Promise<TriggerSummary[]> => {
    const reader = requireReader(principal, LIST_ACTION);
    const { agentId } = triggerListInputSchema.parse(input);
    authorize(reader, LIST_ACTION, {
      kind: TRIGGER_KIND,
      workspaceId: reader.workspaceId,
    });
    if (agentId !== undefined) {
      requireOwnAgent(reader, agentId, LIST_ACTION);
    }
    const onlyAgent = reader.kind === "run" ? reader.agentId : agentId;
    return await db
      .select(summaryColumns)
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          eq(triggers.workspaceId, reader.workspaceId),
          inArray(triggers.kind, ["http", "app"]),
          onlyAgent === undefined ? undefined : eq(triggers.agentId, onlyAgent)
        )
      )
      .orderBy(desc(triggers.createdAt), desc(triggers.id));
  };

  /**
   * Approves a proposal: mints its token, which is returned once, and turns
   * the trigger on. Approving needs the rights that creating a trigger
   * needs, and a run has none.
   */
  const approve = async (
    principal: Principal,
    triggerId: string
  ): Promise<TriggerWithSecret> => {
    const user = requireApprover(principal, APPROVE_ACTION);
    authorize(user, CREATE_ACTION, {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await requireLive(triggerId, user.workspaceId);
    if (current.kind !== "http" || !isPendingProposal(current)) {
      throw new ServiceError("conflict", "Trigger is not waiting for approval");
    }
    const { hash, token } = await hashedToken(TRIGGER_TOKEN_PREFIX);
    const approved = await db
      .update(triggers)
      .set({
        approvedAt: clock.now().toISOString(),
        disabledAt: null,
        tokenHash: hash,
        tokenPrefix: tokenHint(token),
      })
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.approvedAt),
          isNull(triggers.revokedAt)
        )
      )
      .returning({ id: triggers.id });
    if (approved.length === 0) {
      throw new ServiceError("conflict", "Trigger is not waiting for approval");
    }
    await recordChange(eventsService, user, {
      agentId: current.agentId,
      change: "approved",
      kind: "http",
      name: current.name,
      triggerId,
      workspaceId: user.workspaceId,
    });
    return {
      secret: token,
      trigger: await requireSummary(triggerId, user.workspaceId),
    };
  };

  /**
   * Pauses a trigger, or resumes it. A paused trigger rejects its
   * token (the route answers 401). Resuming a proposal is approving it. A run can only pause.
   */
  const setEnabled = async (
    principal: Principal,
    input: TriggerSetEnabledInput
  ): Promise<TriggerWithSecret> => {
    const actor = requireWriter(principal, ENABLE_ACTION);
    const { enabled, triggerId } = triggerSetEnabledInputSchema.parse(input);
    authorize(actor, ENABLE_ACTION, {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: actor.workspaceId,
    });
    if (actor.kind === "run" && enabled) {
      throw new ForbiddenError(ENABLE_ACTION);
    }
    const current = await requireLive(triggerId, actor.workspaceId);
    requireOwnAgent(actor, current.agentId, ENABLE_ACTION);
    if (enabled && isPendingProposal(current)) {
      return await approve(actor, triggerId);
    }
    await db
      .update(triggers)
      .set({ disabledAt: enabled ? null : clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, actor.workspaceId)
        )
      );
    return {
      secret: null,
      trigger: await requireSummary(triggerId, actor.workspaceId),
    };
  };

  /**
   * Revokes a trigger. One already revoked keeps its first timestamp: the
   * update only matches rows with `revoked_at` null. A run revokes only a
   * trigger its agent proposed.
   */
  const revoke = async (
    principal: Principal,
    triggerId: string
  ): Promise<TriggerSummary> => {
    const actor = requireWriter(principal, REVOKE_ACTION);
    authorize(actor, REVOKE_ACTION, {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: actor.workspaceId,
    });
    const current = await requireSummary(triggerId, actor.workspaceId);
    if (actor.kind === "run" && current.proposedByAgentId !== actor.agentId) {
      throw new ForbiddenError(REVOKE_ACTION);
    }
    const revoked = await db
      .update(triggers)
      .set({ revokedAt: clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, actor.workspaceId),
          inArray(triggers.kind, ["http", "app"]),
          isNull(triggers.revokedAt)
        )
      )
      .returning({ id: triggers.id });
    if (revoked.length > 0) {
      await recordChange(eventsService, actor, {
        agentId: current.agentId,
        change: "deleted",
        kind: current.kind,
        name: current.name,
        triggerId,
        workspaceId: actor.workspaceId,
      });
    }
    return await requireSummary(triggerId, actor.workspaceId);
  };

  /** Rejects a proposal: the trigger is revoked and the log says it was rejected. */
  const reject = async (
    principal: Principal,
    triggerId: string
  ): Promise<TriggerSummary> => {
    const user = requireApprover(principal, REJECT_ACTION);
    authorize(user, CREATE_ACTION, {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await requireLive(triggerId, user.workspaceId);
    if (current.kind !== "http" || !isPendingProposal(current)) {
      throw new ServiceError("conflict", "Trigger is not waiting for approval");
    }
    const rejected = await db
      .update(triggers)
      .set({ revokedAt: clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.approvedAt),
          isNull(triggers.revokedAt)
        )
      )
      .returning({ id: triggers.id });
    if (rejected.length === 0) {
      throw new ServiceError("conflict", "Trigger is not waiting for approval");
    }
    await recordChange(eventsService, user, {
      agentId: current.agentId,
      change: "rejected",
      kind: "http",
      name: current.name,
      triggerId,
      workspaceId: user.workspaceId,
    });
    return await requireSummary(triggerId, user.workspaceId);
  };

  /** Whether the run already has its `trigger.fired` event (a retried request). */
  const alreadyAnnounced = async (runId: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.type, "trigger.fired")))
      .limit(1);
    return row !== undefined;
  };

  /**
   * Starts a run for the trigger the token belongs to. A token opens its own
   * trigger and no other, so a mismatch with `triggerId` is forbidden. The
   * `requestId` is kept per trigger: the same one twice gives the same run.
   * With `waitMs` the call waits for the run to end and `finished` says
   * whether it did.
   */
  const fire = async (
    principal: Principal,
    triggerId: string,
    rawInput: TriggerFireInput,
    app?: { state: string; sessionKey?: string }
  ): Promise<FireResult> => {
    if (principal.kind !== "trigger" || principal.triggerId !== triggerId) {
      throw new ForbiddenError(FIRE_ACTION);
    }
    const input = triggerFireInputSchema.parse(rawInput);
    const [trigger] = await db
      .select({
        agentId: triggers.agentId,
        artifactId: triggers.artifactId,
        disabledAt: triggers.disabledAt,
        kind: triggers.kind,
        revokedAt: triggers.revokedAt,
        workspaceId: triggers.workspaceId,
      })
      .from(triggers)
      .where(eq(triggers.id, triggerId))
      .limit(1);
    // The token was valid when the request came in; revoking or pausing since closes it.
    if (!trigger || trigger.revokedAt !== null || trigger.disabledAt !== null) {
      throw new ForbiddenError(FIRE_ACTION);
    }
    if (app && (trigger.kind !== "app" || !trigger.artifactId)) {
      throw new ForbiddenError(FIRE_ACTION);
    }
    authorize(principal, FIRE_ACTION, {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: trigger.workspaceId,
    });
    const started = await runs.startRun(principal, {
      agentId: trigger.agentId,
      input: { text: input.text },
      reply:
        app && trigger.artifactId
          ? { artifactId: trigger.artifactId, kind: "app", state: app.state }
          : undefined,
      requestId:
        input.requestId === undefined
          ? undefined
          : `trigger:${triggerId}:${input.requestId}`,
      session: { externalKey: app?.sessionKey, origin: "trigger" },
    });
    if (!(await alreadyAnnounced(started.runId))) {
      await eventsService.append({
        actor: { id: triggerId, kind: "trigger" },
        agentId: trigger.agentId,
        payload: { requestId: input.requestId ?? null, triggerId },
        runId: started.runId,
        sessionId: started.sessionId,
        type: "trigger.fired",
        workspaceId: trigger.workspaceId,
      });
    }
    await db
      .update(triggers)
      .set({ lastFiredAt: clock.now().toISOString() })
      .where(eq(triggers.id, triggerId));
    const waitMs = input.waitMs ?? 0;
    const run = await runs.waitForRun(principal, started.runId, waitMs);
    return {
      finished: waitMs > 0 && TERMINAL_STATUSES.includes(run.status),
      run,
    };
  };

  return {
    approve,
    authenticate,
    create,
    fire,
    list,
    reassign,
    reject,
    revoke,
    setEnabled,
  };
};

export type TriggersService = ReturnType<typeof createTriggersService>;
