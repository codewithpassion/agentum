import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { runs } from "@repo/db/schema/runs";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { priceTokens } from "../model-pricing.ts";
import type { RunRecord, Usage } from "../runs/types.ts";
import { modelFor } from "./config.ts";
import type { ManagedGateway, SessionUsage } from "./gateway.ts";

/** How many earlier runs of a session are read to find its last recorded totals. */
const PRIOR_RUNS = 5;

const ZERO: SessionUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
};

const isTotals = (value: unknown): value is SessionUsage =>
  typeof value === "object" &&
  value !== null &&
  "inputTokens" in value &&
  typeof value.inputTokens === "number" &&
  "outputTokens" in value &&
  typeof value.outputTokens === "number" &&
  "cacheReadTokens" in value &&
  typeof value.cacheReadTokens === "number" &&
  "cacheWriteTokens" in value &&
  typeof value.cacheWriteTokens === "number" &&
  "costUsd" in value &&
  (value.costUsd === null || typeof value.costUsd === "number");

/**
 * What the session had used when the session's previous run was recorded, or
 * nothing used when it has no such run. A session serves its runs one at a
 * time and reports its use in all, so a run's own use is the difference.
 */
const totalsBefore = async (
  db: Database,
  run: RunRecord
): Promise<SessionUsage> => {
  const rows = await db
    .select({ usage: runs.usage })
    .from(runs)
    .where(
      and(
        eq(runs.sessionId, run.sessionId),
        ne(runs.id, run.id),
        isNotNull(runs.usage)
      )
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(PRIOR_RUNS);
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.usage ?? "null");
      const totals =
        typeof parsed === "object" &&
        parsed !== null &&
        "sessionTotals" in parsed
          ? parsed.sessionTotals
          : null;
      if (isTotals(totals)) {
        return totals;
      }
    } catch {
      // A usage that is not JSON says nothing about the session's totals.
    }
  }
  return ZERO;
};

const costOfRun = (
  model: string,
  now: SessionUsage,
  before: SessionUsage,
  tokens: Omit<SessionUsage, "costUsd">
): number | undefined => {
  if (now.costUsd !== null && before.costUsd !== null) {
    return Math.max(0, now.costUsd - before.costUsd);
  }
  return priceTokens(model, tokens) ?? undefined;
};

/**
 * What the run used, from what its Anthropic session reports. Undefined when
 * the session reports no usage or cannot be read: the run then finishes with
 * no usage, as it always did, rather than not finishing.
 */
export const managedRunUsage = async ({
  db,
  gateway,
  run,
  sessionId,
}: {
  db: Database;
  gateway: ManagedGateway;
  run: RunRecord;
  sessionId: string;
}): Promise<Usage | undefined> => {
  let now: SessionUsage | null;
  try {
    now = await gateway.getUsage(sessionId);
  } catch (error) {
    console.error(
      `Reading the usage of managed run ${run.id} failed:`,
      error instanceof Error ? error.message : error
    );
    return;
  }
  if (!now) {
    return;
  }
  const [agent] = await db
    .select({ model: agents.model })
    .from(agents)
    .where(eq(agents.id, run.agentId))
    .limit(1);
  const model = modelFor(run.model ?? agent?.model ?? "");
  const before = await totalsBefore(db, run);
  const tokens = {
    cacheReadTokens: Math.max(0, now.cacheReadTokens - before.cacheReadTokens),
    cacheWriteTokens: Math.max(
      0,
      now.cacheWriteTokens - before.cacheWriteTokens
    ),
    inputTokens: Math.max(0, now.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - before.outputTokens),
  };
  const costUsd = costOfRun(model, now, before, tokens);
  return {
    ...tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    model,
    provider: "anthropic",
    sessionTotals: now,
  };
};
