/**
 * What a task left in the library. A task is one run, and its output folder is
 * `agents/<slug>/tasks/<runId>`. `taskFiles` returns the entries under that
 * folder, the edits the run made outside it, and its open conflicts. A run is
 * visible only through its session, as in the tasks service, so another
 * member's private session never leaks its files.
 */
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import {
  libraryConflicts,
  libraryEntries,
  libraryVersions,
} from "@repo/db/schema/library";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { type LibraryVersionOp, taskFolderPath } from "@repo/db/shared";
import { and, asc, desc, eq, gte, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { type LibraryEntry, toEntry, underFolder } from "../library.ts";
import { visibleSessions } from "../sessions.ts";
import type { Principal } from "../workspaces.ts";

const READ_ACTION = "tasks.read";
const TASK_KIND = "task";

export const taskFilesInputSchema = z.strictObject({
  runId: z.string().min(1).max(200),
});
export type TaskFilesInput = z.input<typeof taskFilesInputSchema>;

/** The latest version of a file the task wrote outside its folder. */
export interface OutsideEdit {
  createdAt: string;
  op: LibraryVersionOp;
  path: string;
  size: number;
  version: number;
  /** The library_versions id. */
  versionId: string;
}

/** A write by the task that lost a race and waits for a person. */
export interface TaskConflict {
  conflictPath: string;
  createdAt: string;
  id: string;
  path: string;
}

export interface TaskFiles {
  conflicts: TaskConflict[];
  entries: LibraryEntry[];
  folder: string;
  outside: OutsideEdit[];
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;

const requireMember = (principal: Principal): UserPrincipal => {
  if (principal.kind !== "user") {
    throw new ForbiddenError(READ_ACTION);
  }
  authorize(principal, READ_ACTION, {
    kind: TASK_KIND,
    workspaceId: principal.workspaceId,
  });
  return principal;
};

/** Creates the reader of a task's library files. */
export const createTaskFiles = ({ db }: { db: Database }) => {
  /**
   * The files of one task (run `taskId`). Throws `not_found` when the run is
   * not in the member's workspace or its session is not visible to them.
   */
  const taskFiles = async (
    principal: Principal,
    taskId: string
  ): Promise<TaskFiles> => {
    const member = requireMember(principal);
    const [row] = await db
      .select({ agentSlug: agents.slug })
      .from(runs)
      .innerJoin(sessions, eq(runs.sessionId, sessions.id))
      .innerJoin(agents, eq(runs.agentId, agents.id))
      .where(
        and(
          await visibleSessions(db, member),
          eq(runs.id, taskId),
          eq(runs.workspaceId, member.workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Task not found");
    }
    const folder = taskFolderPath(row.agentSlug, taskId);
    const { workspaceId } = member;

    const entryRows = await db
      .select()
      .from(libraryEntries)
      .where(underFolder(workspaceId, folder))
      .orderBy(asc(libraryEntries.path));

    const outsideFolder = and(
      ne(libraryVersions.path, folder),
      or(
        lt(libraryVersions.path, `${folder}/`),
        gte(libraryVersions.path, `${folder}0`)
      )
    );
    const versionRows = await db
      .select()
      .from(libraryVersions)
      .where(
        and(
          eq(libraryVersions.workspaceId, workspaceId),
          eq(libraryVersions.runId, taskId),
          outsideFolder
        )
      )
      .orderBy(asc(libraryVersions.path), desc(libraryVersions.version));
    const latest = new Map<string, OutsideEdit>();
    for (const version of versionRows) {
      if (!latest.has(version.path)) {
        latest.set(version.path, {
          createdAt: version.createdAt,
          op: version.op,
          path: version.path,
          size: version.size,
          version: version.version,
          versionId: version.id,
        });
      }
    }

    const conflictRows = await db
      .select({
        conflictPath: libraryConflicts.conflictPath,
        createdAt: libraryConflicts.createdAt,
        id: libraryConflicts.id,
        path: libraryConflicts.path,
      })
      .from(libraryConflicts)
      .where(
        and(
          eq(libraryConflicts.workspaceId, workspaceId),
          eq(libraryConflicts.runId, taskId),
          eq(libraryConflicts.status, "open")
        )
      )
      .orderBy(asc(libraryConflicts.createdAt), asc(libraryConflicts.id));

    return {
      conflicts: conflictRows,
      entries: entryRows.map(toEntry),
      folder,
      outside: [...latest.values()],
    };
  };

  return { taskFiles };
};
