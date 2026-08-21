import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { AGENT_MODEL, isAvailableModel } from "#/modules/anthropic/config";
import { type AgentModelOverride, agentModelOverrides, agents } from "./schema";

/**
 * Per-conversation model overrides, and the one function that reads them.
 *
 * The resolution order is thread -> channel -> the agent's own model -> the
 * workspace default, and `resolveModel` is the only place it is spelled out:
 * every surface (web, Slack, routines) converges on the router's wake path, so
 * one helper covers all of them.
 *
 * A channel-level row carries `''` in `threadParentId` rather than NULL - see
 * the schema for why - so the sentinel is applied here, once, at the boundary.
 */

/** Channel-level rows use this in place of a thread id. */
export const CHANNEL_SCOPE = "";

export interface OverrideScope {
  agentId: string;
  channelId: string;
  /** Omitted or null addresses the channel itself. */
  threadParentId?: string | null;
}

export interface UpsertOverrideInput extends OverrideScope {
  /** `"agent:<id>"` or `"routine:<id>"`. */
  createdBy: string;
  model: string;
  workspaceId: string;
}

const scopeOf = (scope: OverrideScope): string =>
  scope.threadParentId ?? CHANNEL_SCOPE;

export const getOverride = async (
  db: Db,
  scope: OverrideScope
): Promise<AgentModelOverride | undefined> => {
  const [row] = await db
    .select()
    .from(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.agentId, scope.agentId),
        eq(agentModelOverrides.channelId, scope.channelId),
        eq(agentModelOverrides.threadParentId, scopeOf(scope))
      )
    );
  return row;
};

/** Setting a model replaces whatever that conversation had. */
export const upsertOverride = async (
  db: Db,
  input: UpsertOverrideInput
): Promise<void> => {
  await db
    .insert(agentModelOverrides)
    .values({
      agentId: input.agentId,
      channelId: input.channelId,
      createdBy: input.createdBy,
      id: crypto.randomUUID(),
      model: input.model,
      threadParentId: scopeOf(input),
      workspaceId: input.workspaceId,
    })
    .onConflictDoUpdate({
      set: {
        createdBy: input.createdBy,
        model: input.model,
        updatedAt: new Date(),
      },
      target: [
        agentModelOverrides.agentId,
        agentModelOverrides.channelId,
        agentModelOverrides.threadParentId,
      ],
    });
};

/** Clearing is a delete: the absence of a row is what "inherit" means. */
export const clearOverride = async (
  db: Db,
  scope: OverrideScope
): Promise<boolean> => {
  const deleted = await db
    .delete(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.agentId, scope.agentId),
        eq(agentModelOverrides.channelId, scope.channelId),
        eq(agentModelOverrides.threadParentId, scopeOf(scope))
      )
    )
    .returning({ id: agentModelOverrides.id });
  return deleted.length > 0;
};

/** Which rung of the precedence ladder answered. */
export type ModelSource =
  | "agent config"
  | "channel override"
  | "thread override"
  | "workspace default";

export interface ResolvedModel {
  model: string;
  source: ModelSource;
}

/**
 * The model this agent should run on in this conversation, and where it came
 * from. `resolveModel` is the same answer with the provenance dropped; only
 * `get_model` needs to say *why*.
 *
 * Anything stored that is no longer in the catalog is skipped rather than sent
 * to the API: a model can be retired from the list long after a row naming it
 * was written, and a wake must not fail because of it.
 */
export const resolveModelWithSource = async (
  db: Db,
  scope: OverrideScope
): Promise<ResolvedModel> => {
  const threadParentId = scopeOf(scope);
  // Both candidate rows in one read; the thread's own row wins if it exists.
  const rows = await db
    .select({
      model: agentModelOverrides.model,
      threadParentId: agentModelOverrides.threadParentId,
    })
    .from(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.agentId, scope.agentId),
        eq(agentModelOverrides.channelId, scope.channelId),
        inArray(
          agentModelOverrides.threadParentId,
          threadParentId === CHANNEL_SCOPE
            ? [CHANNEL_SCOPE]
            : [threadParentId, CHANNEL_SCOPE]
        )
      )
    );

  // A channel-scoped lookup has one rung, not two: its own key *is* the
  // sentinel, and calling that row a thread override would misreport it.
  const rungs =
    threadParentId === CHANNEL_SCOPE
      ? ([{ key: CHANNEL_SCOPE, source: "channel override" }] as const)
      : ([
          { key: threadParentId, source: "thread override" },
          { key: CHANNEL_SCOPE, source: "channel override" },
        ] as const);
  for (const rung of rungs) {
    const model = rows.find((row) => row.threadParentId === rung.key)?.model;
    if (isAvailableModel(model)) {
      return { model, source: rung.source };
    }
  }

  const [agent] = await db
    .select({ model: agents.model })
    .from(agents)
    .where(eq(agents.id, scope.agentId));
  const own = agent?.model;
  return isAvailableModel(own)
    ? { model: own, source: "agent config" }
    : { model: AGENT_MODEL, source: "workspace default" };
};

export const resolveModel = async (
  db: Db,
  scope: OverrideScope
): Promise<string> => (await resolveModelWithSource(db, scope)).model;
