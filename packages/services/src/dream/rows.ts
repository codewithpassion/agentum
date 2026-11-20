// What the dream service reads and shapes: the agent a dream is about, the
// stored rows as the contract types, and the principal a dream writes as.
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import type { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DEFAULT_DREAM_COUNTS_JSON,
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  type DreamCounts,
  type DreamQuestion,
  type DreamRun,
  type DreamUsage,
  type RememberRules,
} from "@repo/db/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { effectiveOwner } from "../guards.ts";
import { rememberRulesSchema } from "../memory/service.ts";
import type { Principal } from "../workspaces.ts";
import { readOptions } from "./question-options.ts";

export type RunRow = typeof dreamRuns.$inferSelect;
export type QuestionRow = typeof dreamQuestions.$inferSelect;

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const countsSchema = z.object({
  added: z.number(),
  dropped: z.number(),
  merged: z.number(),
  questions: z.number(),
});
const usageSchema = z.object({
  costUsd: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

export const toRun = (row: RunRow): DreamRun => {
  const counts = countsSchema.safeParse(parseJson(row.counts));
  const base = z.array(z.string()).safeParse(parseJson(row.baseVersion));
  const usage: DreamUsage | null = row.usage
    ? (usageSchema.safeParse(parseJson(row.usage)).data ?? null)
    : null;
  return {
    agentId: row.agentId,
    baseVersion: base.success ? base.data : [],
    counts: counts.success
      ? counts.data
      : (JSON.parse(DEFAULT_DREAM_COUNTS_JSON) as DreamCounts),
    diary: row.diary,
    error: row.error,
    finishedAt: row.finishedAt,
    id: row.id,
    resultVersion: row.resultVersion,
    since: row.since,
    startedAt: row.startedAt,
    status: row.status,
    teamId: row.teamId,
    usage,
  };
};

export const toQuestion = (row: QuestionRow): DreamQuestion => ({
  agentId: row.agentId,
  answeredAt: row.answeredAt,
  answeredBy: row.answeredBy,
  answeredNoteId: row.answeredNoteId,
  createdAt: row.createdAt,
  dreamRunId: row.dreamRunId,
  id: row.id,
  options: readOptions(row.options).options,
  question: row.question,
  status: row.status,
  teamId: row.teamId,
});

export interface DreamAgent {
  createdBy: string;
  id: string;
  name: string;
  ownerUserId: string;
  rules: RememberRules;
  slug: string;
  status: string;
  workspaceId: string;
  /** The workspace's never list, which every agent in it inherits. */
  workspaceNever: string[];
}

const rulesFrom = (raw: string): RememberRules => {
  const parsed = rememberRulesSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : structuredClone(DEFAULT_REMEMBER_RULES);
};

const neverFrom = (raw: string | undefined): string[] => {
  const parsed = z.array(z.string()).safeParse(parseJson(raw ?? "null"));
  return parsed.success ? parsed.data : [...DEFAULT_NEVER_REMEMBER];
};

/** The agent a dream is about. With no workspace, the id alone names it: the tick has none. */
export const loadDreamAgent = async (
  db: Database,
  agentId: string,
  workspaceId?: string
): Promise<DreamAgent> => {
  const [row] = await db
    .select({
      createdBy: agents.createdBy,
      id: agents.id,
      name: agents.name,
      neverRemember: workspaces.neverRemember,
      ownerUserId: agents.ownerUserId,
      remember: agents.remember,
      slug: agents.slug,
      status: agents.status,
      workspaceId: agents.workspaceId,
    })
    .from(agents)
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(
      and(
        eq(agents.id, agentId),
        workspaceId === undefined
          ? undefined
          : eq(agents.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!row) {
    throw notFound(`No agent "${agentId}"`);
  }
  return {
    createdBy: row.createdBy,
    id: row.id,
    name: row.name,
    ownerUserId: effectiveOwner(row),
    rules: rulesFrom(row.remember),
    slug: row.slug,
    status: row.status,
    workspaceId: row.workspaceId,
    workspaceNever: neverFrom(row.neverRemember),
  };
};

/**
 * The principal a dream reads and writes the library as. It is a person's
 * shape because the library has no other writer, named for the agent so the
 * log does not blame the owner, and marked so it may reach every person's
 * private memory file. It exists only in this service's process.
 */
export const dreamPrincipal = (agent: {
  id: string;
  workspaceId: string;
}): Principal => ({
  dream: true,
  kind: "user",
  userId: `dream:${agent.id}`,
  via: "session",
  workspaceId: agent.workspaceId,
});
