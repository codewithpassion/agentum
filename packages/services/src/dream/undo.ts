// Undo and the owner's decision on a held dream. A dream is undone as a whole:
// every memory file it wrote goes back to the bytes it had before, so the
// result is the memory the owner had the day before. That is only safe while
// nobody has written those files since, and when somebody has, the undo is
// refused instead of throwing their notes away.
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import type { DreamDecision } from "@repo/db/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { ServiceError } from "../errors.ts";
import { memoryFolderOf } from "../library/memory-paths.ts";
import {
  buildIndex,
  MemoryCodecError,
  type MemoryFiles,
  parseMemoryFile,
  serializeMemoryFile,
} from "../memory/codec.ts";
import {
  changedPaths,
  commitFiles,
  type DreamMemoryLibrary,
  describeProblem,
  latestVersionIds,
  loadEveryMemoryFile,
} from "../memory/files.ts";
import type { Clock } from "../runs/types.ts";
import { applyRows, pathOfRow } from "./changeset.ts";
import { readOptions } from "./question-options.ts";
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

const notesIn = (files: MemoryFiles) =>
  Object.entries(files).flatMap(([path, text]) => {
    if (path === INDEX) {
      return [];
    }
    const parsed = parseMemoryFile(path, text);
    return parsed.ok ? parsed.notes : [];
  });

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

  /**
   * Closes questions of this run without an answer: the notes they ask about
   * are gone or were never written. `noteIds` limits it to the questions that
   * name one of those notes. A statement only when something is open.
   */
  const closeQuestions = async (
    runId: string,
    userId: string,
    now: string,
    noteIds?: ReadonlySet<string>
  ): Promise<Statement[]> => {
    const open = await db
      .select({ id: dreamQuestions.id, options: dreamQuestions.options })
      .from(dreamQuestions)
      .where(
        and(
          eq(dreamQuestions.dreamRunId, runId),
          eq(dreamQuestions.status, "open")
        )
      );
    const ids = open
      .filter(
        (question) =>
          noteIds === undefined ||
          readOptions(question.options).options.some((option) =>
            noteIds.has(option.noteId)
          )
      )
      .map((question) => question.id);
    if (ids.length === 0) {
      return [];
    }
    return [
      db
        .update(dreamQuestions)
        .set({ answeredAt: now, answeredBy: userId, status: "answered" })
        .where(
          and(
            inArray(dreamQuestions.id, ids),
            eq(dreamQuestions.status, "open")
          )
        ),
    ];
  };

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
      const path = version.path.slice(folder.length);
      // The index is rebuilt from the restored files, never restored: a person
      // may have written other files since, and the index must list them.
      if (version.path.startsWith(folder) && path !== INDEX) {
        restored[path] = decoder.decode(bytes);
      }
    }
    // A file the dream made has no earlier version: it goes back to empty.
    for (const path of paths) {
      restored[path] ??= serializeMemoryFile(path, []);
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
    // A row whose file the dream did not change has no version to compare.
    const made = new Map(
      rows.flatMap((row) =>
        row.libraryVersionId === null
          ? []
          : [[pathOfRow(row), row.libraryVersionId] as const]
      )
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
    const principal = dreamPrincipal(agent);
    const loaded = await loadEveryMemoryFile(library, principal, agent.slug);
    // The files and their etags are read first and the versions after, so a
    // write that lands in between shows up as a newer version and is refused,
    // never restored over. A write after both reads fails the etag instead.
    await ensureUntouched(agent, rows);
    const [problem] = Object.entries(loaded.problems);
    if (problem) {
      throw new ServiceError("invalid", describeProblem(...problem));
    }
    const paths = [
      ...new Set(
        rows.flatMap((row) =>
          row.libraryVersionId === null ? [] : pathOfRow(row)
        )
      ),
    ];
    const next: MemoryFiles = {
      ...loaded.texts,
      ...(await restoredFiles(run, agent, paths)),
    };
    next[INDEX] = buildIndex(notesIn(next));
    const now = clock.now().toISOString();
    const closing = await closeQuestions(run.id, userId, now);
    const statements = (): Statement[] => [
      ...closing,
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
      // A question that names a held note asks about a change that will not happen.
      const closing = await closeQuestions(
        run.id,
        userId,
        now,
        new Set(rows.map((row) => row.noteId))
      );
      await atomic([
        ...closing,
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
    // The files the dream was made against must be the files there are now.
    // The versions are read after the files, so a write that lands in between
    // is caught here and not written over.
    const against = new Set(toRun(run).baseVersion);
    const latest = await latestVersionIds(library, principal, agent.slug, [
      ...new Set(rows.map(pathOfRow)),
    ]);
    if (latest.some((id) => !against.has(id))) {
      throw new ServiceError(
        "conflict",
        "Memory changed since this dream ran, so its changes no longer fit. Reject them."
      );
    }
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
                written.versionByPath.get(pathOfRow(row)) ?? null,
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
