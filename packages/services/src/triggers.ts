/**
 * HTTP triggers: a way to start one agent from outside with a per-trigger
 * bearer token (`hm_trg_`). A signed-in user makes and revokes triggers. The
 * secret is shown once, at creation, and the table keeps only its SHA-256. A
 * caller with the token calls `fire`, which starts a run through `startRun`
 * as the trigger itself: the run is on behalf of nobody.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import type { TriggerKind } from "@repo/db/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
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

export const TRIGGER_TOKEN_PREFIX = "hm_trg_";
/** Characters of the random part shown back, so triggers can be told apart. */
const HINT_LENGTH = 4;
/** The longest `requestId` a caller may send. It is stored with a prefix. */
export const REQUEST_ID_MAX = 128;

const TRIGGER_KIND = "trigger";
const CREATE_ACTION = "triggers.create";
const LIST_ACTION = "triggers.list";
const REVOKE_ACTION = "triggers.revoke";
const FIRE_ACTION = "triggers.fire";

type UserPrincipal = Extract<Principal, { kind: "user" }>;
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
  createdAt: string;
  id: string;
  kind: TriggerKind;
  lastFiredAt: string | null;
  name: string;
  revokedAt: string | null;
  tokenPrefix: string;
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
  createdAt: triggers.createdAt,
  id: triggers.id,
  kind: triggers.kind,
  lastFiredAt: triggers.lastFiredAt,
  name: triggers.name,
  revokedAt: triggers.revokedAt,
  tokenPrefix: triggers.tokenPrefix,
};

/** Triggers are managed from a signed-in session: a trigger cannot make triggers. */
const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

export const createTriggersService = ({
  allowedOrgIds,
  clock,
  db,
  events: eventsService,
  runs,
}: {
  allowedOrgIds: readonly string[];
  clock: Clock;
  db: Database;
  events: EventsService;
  runs: RunsService;
}) => {
  /**
   * The trigger principal for `Authorization: Bearer hm_trg_...`, or null. A
   * revoked trigger, an unknown token and a workspace outside
   * `allowedOrgIds` are all null.
   */
  const authenticate = async (
    authorization: string | null
  ): Promise<TriggerPrincipal | null> => {
    const token = bearerToken(authorization);
    if (!token?.startsWith(TRIGGER_TOKEN_PREFIX)) {
      return null;
    }
    const principal = await findTriggerByToken(db, token);
    if (!principal) {
      return null;
    }
    const [workspace] = await db
      .select({ clerkOrgId: workspaces.clerkOrgId })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    return workspace && allowedOrgIds.includes(workspace.clerkOrgId)
      ? principal
      : null;
  };

  /** A new HTTP trigger for one agent. The returned `secret` is the only copy. */
  const create = async (
    principal: Principal,
    input: TriggerCreateInput
  ): Promise<{ secret: string; trigger: TriggerSummary }> => {
    const user = requireUser(principal, CREATE_ACTION);
    const { agentId, name } = triggerCreateInputSchema.parse(input);
    authorize(user, CREATE_ACTION, {
      kind: TRIGGER_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: user.workspaceId,
    });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    const now = clock.now();
    const { hash, token } = await hashedToken(TRIGGER_TOKEN_PREFIX);
    const trigger: TriggerSummary = {
      agentId: agent.id,
      agentName: agent.name,
      createdAt: now.toISOString(),
      id: `trg_${ulid(now.getTime())}`,
      kind: "http",
      lastFiredAt: null,
      name,
      revokedAt: null,
      tokenPrefix: token.slice(0, TRIGGER_TOKEN_PREFIX.length + HINT_LENGTH),
    };
    await db.insert(triggers).values({
      agentId: trigger.agentId,
      createdAt: trigger.createdAt,
      createdBy: user.userId,
      id: trigger.id,
      kind: trigger.kind,
      name: trigger.name,
      tokenHash: hash,
      tokenPrefix: trigger.tokenPrefix,
      workspaceId: user.workspaceId,
    });
    return { secret: token, trigger };
  };

  /** The workspace's triggers, newest first, revoked ones included. */
  const list = async (
    principal: Principal,
    input: TriggerListInput = {}
  ): Promise<TriggerSummary[]> => {
    const user = requireUser(principal, LIST_ACTION);
    const { agentId } = triggerListInputSchema.parse(input);
    authorize(user, LIST_ACTION, {
      kind: TRIGGER_KIND,
      workspaceId: user.workspaceId,
    });
    return await db
      .select(summaryColumns)
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          eq(triggers.workspaceId, user.workspaceId),
          agentId === undefined ? undefined : eq(triggers.agentId, agentId)
        )
      )
      .orderBy(desc(triggers.createdAt), desc(triggers.id));
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
        and(eq(triggers.id, triggerId), eq(triggers.workspaceId, workspaceId))
      )
      .limit(1);
    return row ?? null;
  };

  /**
   * Revokes a trigger. One already revoked keeps its first timestamp: the
   * update only matches rows with `revoked_at` null.
   */
  const revoke = async (
    principal: Principal,
    triggerId: string
  ): Promise<TriggerSummary> => {
    const user = requireUser(principal, REVOKE_ACTION);
    authorize(user, REVOKE_ACTION, {
      id: triggerId,
      kind: TRIGGER_KIND,
      workspaceId: user.workspaceId,
    });
    await db
      .update(triggers)
      .set({ revokedAt: clock.now().toISOString() })
      .where(
        and(
          eq(triggers.id, triggerId),
          eq(triggers.workspaceId, user.workspaceId),
          isNull(triggers.revokedAt)
        )
      );
    const current = await findSummary(triggerId, user.workspaceId);
    if (!current) {
      throw new ServiceError("not_found", "Trigger not found");
    }
    return current;
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
    rawInput: TriggerFireInput
  ): Promise<FireResult> => {
    if (principal.kind !== "trigger" || principal.triggerId !== triggerId) {
      throw new ForbiddenError(FIRE_ACTION);
    }
    const input = triggerFireInputSchema.parse(rawInput);
    const [trigger] = await db
      .select({
        agentId: triggers.agentId,
        revokedAt: triggers.revokedAt,
        workspaceId: triggers.workspaceId,
      })
      .from(triggers)
      .where(eq(triggers.id, triggerId))
      .limit(1);
    // The token was valid when the request came in; revoking since closes it.
    if (!trigger || trigger.revokedAt !== null) {
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
      requestId:
        input.requestId === undefined
          ? undefined
          : `trigger:${triggerId}:${input.requestId}`,
      session: { origin: "trigger" },
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

  return { authenticate, create, fire, list, revoke };
};

export type TriggersService = ReturnType<typeof createTriggersService>;
