import type { Database } from "@repo/db";
import { files } from "@repo/db/schema/files";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import type { EventActorKind } from "@repo/db/shared";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { ServiceError } from "../errors.ts";
import { toRecord } from "./records.ts";
import type { RunRecord } from "./types.ts";

/** A run by id. `workspaceId` is absent only for the system principal. */
export const loadRun = async (
  db: Database,
  runId: string,
  workspaceId?: string
): Promise<RunRecord | null> => {
  const conditions: SQL[] = [eq(runs.id, runId)];
  if (workspaceId) {
    conditions.push(eq(runs.workspaceId, workspaceId));
  }
  const [row] = await db
    .select()
    .from(runs)
    .where(and(...conditions))
    .limit(1);
  return row ? toRecord(row) : null;
};

export const loadRunByRequest = async (
  db: Database,
  workspaceId: string,
  requestId: string
): Promise<RunRecord | null> => {
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(eq(runs.workspaceId, workspaceId), eq(runs.requestId, requestId))
    )
    .limit(1);
  return row ? toRecord(row) : null;
};

/**
 * The session for a key, or null. A `ui` or private session belongs to whoever
 * opened it: another actor with the same key gets "not found".
 */
export const findSession = async (
  db: Database,
  key: {
    actor: { id: string; kind: EventActorKind };
    agentId: string;
    externalKey: string;
    origin: string;
    workspaceId: string;
  }
) => {
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.workspaceId, key.workspaceId),
        eq(sessions.agentId, key.agentId),
        eq(sessions.origin, key.origin),
        eq(sessions.externalKey, key.externalKey)
      )
    )
    .limit(1);
  if (!session) {
    return null;
  }
  const foreign =
    session.actorKind !== key.actor.kind || session.actorId !== key.actor.id;
  if ((key.origin === "ui" || session.private) && foreign) {
    throw new ServiceError("not_found", "Session not found");
  }
  return session;
};

/**
 * Throws "not found" for the first file id that is missing from the
 * workspace, or, when `ownerUserId` is given, not that user's own upload, or,
 * when `runId` is given, not an output of that run.
 */
export const requireFiles = async (
  db: Database,
  query: {
    fileIds: readonly string[];
    ownerUserId?: string;
    runId?: string;
    workspaceId: string;
  }
) => {
  if (query.fileIds.length === 0) {
    return;
  }
  const conditions: SQL[] = [
    inArray(files.id, [...query.fileIds]),
    eq(files.workspaceId, query.workspaceId),
  ];
  if (query.runId !== undefined) {
    conditions.push(eq(files.runId, query.runId));
  }
  if (query.ownerUserId !== undefined) {
    conditions.push(
      eq(files.createdByKind, "user"),
      eq(files.createdById, query.ownerUserId)
    );
  }
  const found = await db
    .select({ id: files.id })
    .from(files)
    .where(and(...conditions));
  const known = new Set(found.map((row) => row.id));
  const missing = query.fileIds.find((id) => !known.has(id));
  if (missing !== undefined) {
    throw new ServiceError("not_found", `File ${missing} not found`);
  }
};
