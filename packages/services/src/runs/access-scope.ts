import type { Database } from "@repo/db";
import { agentConnectors } from "@repo/db/schema/connectors";
import { runs } from "@repo/db/schema/runs";
import { agentSecrets } from "@repo/db/schema/secrets";
import { and, eq } from "drizzle-orm";
import { ServiceError } from "../errors.ts";

import type { RunAccessScope } from "./types.ts";

export type { RunAccessScope } from "./types.ts";

type ScopeKey = keyof RunAccessScope;
const KEYS: ScopeKey[] = ["connectors", "secrets", "tools"];

const intersection = (
  left: string[] | undefined,
  right: string[] | undefined
) =>
  left === undefined
    ? right
    : left.filter((id) => right === undefined || right.includes(id));

/** Re-read every scope in the subagent chain, so stored child access cannot widen its parent. */
export const effectiveRunScope = async (
  db: Database,
  workspaceId: string,
  runId: string
): Promise<RunAccessScope | null> => {
  let cursor: string | null = runId;
  let scope: RunAccessScope | null = null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    // biome-ignore lint/performance/noAwaitInLoops: each parent id comes from the previous row
    const [run] = await db
      .select({
        accessScope: runs.accessScope,
        parentRunId: runs.parentRunId,
        subagentLevel: runs.subagentLevel,
      })
      .from(runs)
      .where(and(eq(runs.id, cursor), eq(runs.workspaceId, workspaceId)))
      .limit(1);
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    if (run.accessScope) {
      const stored: RunAccessScope = JSON.parse(run.accessScope);
      scope ??= {};
      for (const key of KEYS) {
        const narrowed = intersection(scope[key], stored[key]);
        if (narrowed !== undefined) {
          scope[key] = narrowed;
        }
      }
    }
    cursor = run.subagentLevel > 0 ? run.parentRunId : null;
  }
  return scope;
};

export const scopeAllows = (
  scope: RunAccessScope | null,
  key: ScopeKey,
  id: string
): boolean => scope?.[key] === undefined || scope[key].includes(id);

export const scopedTools = (
  scope: RunAccessScope | null,
  allowed: string[] | null
): string[] | null => {
  const tools = scope?.tools;
  if (tools === undefined) {
    return allowed;
  }
  return tools.filter((tool) => allowed === null || allowed.includes(tool));
};

/** Snapshot today's grants, refusing requested ids outside the parent's effective access. */
export const validateSubagentAccess = async (
  db: Database,
  parent: { id: string; agentId: string; workspaceId: string },
  requested: RunAccessScope = {}
): Promise<RunAccessScope> => {
  const [scope, connectorRows, secretRows] = await Promise.all([
    effectiveRunScope(db, parent.workspaceId, parent.id),
    db
      .select({ id: agentConnectors.connectorId })
      .from(agentConnectors)
      .where(
        and(
          eq(agentConnectors.agentId, parent.agentId),
          eq(agentConnectors.workspaceId, parent.workspaceId)
        )
      ),
    db
      .select({ id: agentSecrets.secretId })
      .from(agentSecrets)
      .where(
        and(
          eq(agentSecrets.agentId, parent.agentId),
          eq(agentSecrets.workspaceId, parent.workspaceId)
        )
      ),
  ]);
  const available: RunAccessScope = {
    connectors: connectorRows
      .map((row) => row.id)
      .filter((id) => scopeAllows(scope, "connectors", id)),
    secrets: secretRows
      .map((row) => row.id)
      .filter((id) => scopeAllows(scope, "secrets", id)),
    ...(scope?.tools === undefined ? {} : { tools: scope.tools }),
  };
  for (const key of KEYS) {
    const selected = requested[key];
    const allowed = available[key];
    if (selected === undefined) {
      continue;
    }
    if (allowed !== undefined && selected.some((id) => !allowed.includes(id))) {
      throw new ServiceError(
        "invalid",
        `Subagents cannot gain ${key} their parent does not have`
      );
    }
    available[key] = [...new Set(selected)];
  }
  return available;
};

/** A run may select its own model without changing the agent's profile. */
export const modelOfRun = (
  run: { model: string | null },
  agent: { model: string }
): string => run.model ?? agent.model;
