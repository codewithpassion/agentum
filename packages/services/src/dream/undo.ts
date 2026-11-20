// Undo and the owner's decision on a held dream. A dream is undone as a whole:
// every memory file it wrote goes back to the bytes it had before, so the
// result is the memory the owner had the day before. That is only safe while
// nobody has written those files since, and when somebody has, the undo is
// refused instead of throwing their notes away.
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import type { DreamDecision } from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import { ServiceError } from "../errors.ts";
import { memoryFolderOf } from "../library/memory-paths.ts";
import {
  buildIndex,
  MemoryCodecError,
  type MemoryFiles,
  serializeMemoryFile,
} from "../memory/codec.ts";
import {
  changedPaths,
  commitFiles,
  type DreamMemoryLibrary,
  loadEveryMemoryFile,
} from "../memory/files.ts";
import type { Clock } from "../runs/types.ts";
import { applyRows, pathOfRow } from "./changeset.ts";

import { type DreamAgent, dreamPrincipal, type RunRow, toRun } from "./rows.ts";

const DATE_LENGTH = 10;
const INDEX = "index.md";

export interface UndoDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  library: DreamMemoryLibrary;
}

const staleMemory = () =>
  new ServiceError(
    "conflict",
    "Memory changed after this dream ran, so it cannot be undone as a whole. Forget or edit the notes you do not want."
  );

export const createDreamUndo = ({ atomic, clock, db, library }: UndoDeps) => {
  const rowsOf = (runId: string, status: "applied" | "held") =>
    db
      .select()
      .from(memoryChanges)
      .where(
        and(
          eq(memoryChanges.dreamRunId, runId),
          eq(memoryChanges.status, status)
        )
      )
      .orderBy(asc(memoryChanges.id));

  const appendDiary = (run: RunRow, line: string): string =>
    run.diary === "" ? line : `${run.diary}\n${line}`;

  /** The bytes a file had before the dream, or its empty form when the dream made it. */
  const restoredFiles = async (
    run: RunRow,
    agent: DreamAgent,
    paths: readonly string[]
  ): Promise<MemoryFiles> => {
    const principal = dreamPrincipal(agent);
    const folder = `${memoryFolderOf(agent.slug)}/`;
    const restored: MemoryFiles = {};
    const decoder = new TextDecoder();
    for (const id of toRun(run).baseVersion) {
      // biome-ignore lint/performance/noAwaitInLoops: one version at a time
      const { bytes, version } = await library.readVersion(principal, id);
      if (version.path.startsWith(folder)) {
        restored[version.path.slice(folder.length)] = decoder.decode(bytes);
      }
    }
    // A file the dream made has no earlier version: it goes back to empty.
    for (const path of paths) {
      restored[path] ??=
        path === INDEX ? buildIndex([]) : serializeMemoryFile(path, []);
    }
    return restored;
  };

  /** Refuses when any note file the dream wrote has been written since. */
  const ensureUntouched = async (
    agent: DreamAgent,
    rows: readonly (typeof memoryChanges.$inferSelect)[]
  ): Promise<void> => {
    const principal = dreamPrincipal(agent);
    const folder = memoryFolderOf(agent.slug);
    const made = new Map(
      rows.map((row) => [pathOfRow(row), row.libraryVersionId] as const)
    );
    for (const [path, versionId] of made) {
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time
      const [latest] = await library.versions(principal, `${folder}/${path}`);
      if (latest?.id !== versionId) {
        throw staleMemory();
      }
    }
  };

  const undo = async (
    run: RunRow,
    agent: DreamAgent,
    userId: string
  ): Promise<void> => {
    if (run.status !== "done" || run.resultVersion === null) {
      throw new ServiceError(
        "conflict",
        "Only a dream that changed memory can be undone"
      );
    }
    const rows = await rowsOf(run.id, "applied");
    if (rows.length === 0) {
      throw new ServiceError("conflict", "This dream has nothing to undo");
    }
    await ensureUntouched(agent, rows);
    const principal = dreamPrincipal(agent);
    const loaded = await loadEveryMemoryFile(library, principal, agent.slug);
    const paths = [...new Set([...rows.map(pathOfRow), INDEX])];
    const next = {
      ...loaded.texts,
      ...(await restoredFiles(run, agent, paths)),
    };
    const now = clock.now().toISOString();
    const statements = (): Statement[] => [
      db
        .update(memoryChanges)
        .set({ decidedAt: now, decidedBy: userId, status: "undone" })
        .where(
          and(
            eq(memoryChanges.dreamRunId, run.id),
            eq(memoryChanges.status, "applied")
          )
        ),
      db
        .update(dreamRuns)
        .set({
          diary: appendDiary(run, "You undid this dream."),
          status: "undone",
        })
        .where(and(eq(dreamRuns.id, run.id), eq(dreamRuns.status, "done"))),
    ];
    if (changedPaths(loaded, next).length === 0) {
      await atomic(statements());
      return;
    }
    await commitFiles({
      library,
      loaded,
      next,
      principal,
      slug: agent.slug,
      statements,
    });
  };

  const decide = async (
    run: RunRow,
    agent: DreamAgent,
    userId: string,
    decision: DreamDecision
  ): Promise<void> => {
    const rows = await rowsOf(run.id, "held");
    if (rows.length === 0) {
      throw new ServiceError("conflict", "This dream holds no changes");
    }
    const now = clock.now().toISOString();
    const decided = { decidedAt: now, decidedBy: userId };
    if (decision === "reject") {
      await atomic([
        db
          .update(memoryChanges)
          .set({ ...decided, status: "rejected" })
          .where(
            and(
              eq(memoryChanges.dreamRunId, run.id),
              eq(memoryChanges.status, "held")
            )
          ),
        db
          .update(dreamRuns)
          .set({
            diary: appendDiary(
              run,
              "You rejected these changes. Nothing was changed."
            ),
          })
          .where(eq(dreamRuns.id, run.id)),
      ]);
      return;
    }
    const principal = dreamPrincipal(agent);
    const loaded = await loadEveryMemoryFile(library, principal, agent.slug);
    let next: MemoryFiles;
    try {
      next = applyRows(loaded.files, rows, now.slice(0, DATE_LENGTH));
    } catch (error) {
      if (error instanceof MemoryCodecError) {
        // biome-ignore lint/style/useErrorCause: ServiceError has no cause parameter
        throw new ServiceError(
          "conflict",
          "Memory changed since this dream ran, so its changes no longer fit. Reject them."
        );
      }
      throw error;
    }
    await commitFiles({
      library,
      loaded,
      next,
      principal,
      slug: agent.slug,
      statements: (written) => [
        ...rows.map((row) =>
          db
            .update(memoryChanges)
            .set({
              ...decided,
              libraryVersionId:
                written.versionByPath.get(pathOfRow(row)) ??
                written.resultVersion,
              status: "applied",
            })
            .where(
              and(
                eq(memoryChanges.id, row.id),
                eq(memoryChanges.status, "held")
              )
            )
        ),
        db
          .update(dreamRuns)
          .set({
            baseVersion: JSON.stringify(written.baseVersion),
            diary: appendDiary(run, "You approved these changes."),
            resultVersion: written.resultVersion,
          })
          .where(eq(dreamRuns.id, run.id)),
      ],
    });
  };

  return { decide, undo };
};
