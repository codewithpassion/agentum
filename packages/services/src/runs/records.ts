import type { runs } from "@repo/db/schema/runs";
import { EVENT_ACTOR_KINDS } from "@repo/db/shared";
import { z } from "zod";
import {
  type RunRecord,
  type RunSummary,
  replyTargetSchema,
  usageSchema,
} from "./types.ts";

export type RunRow = typeof runs.$inferSelect;

const stringList = z.array(z.string());
const actorKindSchema = z.enum(EVENT_ACTOR_KINDS);

/** A run row with its JSON columns parsed. */
export const toRecord = (row: RunRow): RunRecord => ({
  actor: { id: row.actorId, kind: actorKindSchema.parse(row.actorKind) },
  agentId: row.agentId,
  claimedBy: row.claimedBy,
  createdAt: row.createdAt,
  depth: row.depth,
  error: row.error,
  finishedAt: row.finishedAt,
  id: row.id,
  inputFileIds: stringList.parse(JSON.parse(row.inputFileIds)),
  inputText: row.inputText,
  leaseUntil: row.leaseUntil,
  onBehalfOfUserId: row.onBehalfOfUserId,
  outputFileIds: stringList.parse(JSON.parse(row.outputFileIds)),
  parentRunId: row.parentRunId,
  pendingFiles:
    row.pendingFiles === null
      ? null
      : z.array(z.unknown()).parse(JSON.parse(row.pendingFiles)),
  processEndedAt: row.processEndedAt,
  reply:
    row.reply === null
      ? { kind: "none" }
      : replyTargetSchema.parse(JSON.parse(row.reply)),
  requestId: row.requestId,
  resultText: row.resultText,
  sessionId: row.sessionId,
  startedAt: row.startedAt,
  status: row.status,
  usage: row.usage === null ? null : usageSchema.parse(JSON.parse(row.usage)),
  workspaceId: row.workspaceId,
});

export const toSummary = (run: RunRecord): RunSummary => ({
  agentId: run.agentId,
  createdAt: run.createdAt,
  error: run.error,
  finishedAt: run.finishedAt,
  id: run.id,
  outputFileIds: run.outputFileIds,
  processEndedAt: run.processEndedAt,
  resultText: run.resultText,
  sessionId: run.sessionId,
  status: run.status,
});
