// One dream of one agent: read what happened since the last one, ask the model
// for notes worth keeping, run the three steps, and write the plan (or hold it
// for the owner). The run is recorded as it goes. Nothing is written to memory
// until the model's work is complete, so a dream that fails leaves memory as
// it was.
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import type {
  DreamCounts,
  DreamPlan,
  DreamRun,
  DreamUsage,
  MemoryNote,
} from "@repo/db/shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Fetcher } from "../connectors/mcp.ts";
import { ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { type ManagedKeysService, NO_KEY_MESSAGE } from "../managed/keys.ts";
import { MemoryCodecError } from "../memory/codec.ts";
import {
  commitFiles,
  type DreamMemoryLibrary,
  describeProblem,
  type LoadedMemory,
  loadEveryMemoryFile,
} from "../memory/files.ts";
import { MEMORY_PROMPT_MAX_CHARS } from "../memory/prompt.ts";
import type { Clock } from "../runs/types.ts";
import type { SkillsStoreService } from "../skills-store.ts";
import type { Principal } from "../workspaces.ts";
import { applyRows, pathOfRow, rowsFromPlan } from "./changeset.ts";
import { createDreamCollector } from "./collect.ts";

import { writeDiary } from "./diary.ts";
import { extractCandidates } from "./extract.ts";
import { createDreamModel } from "./model.ts";
import { storeOptions } from "./question-options.ts";
import {
  type DreamAgent,
  dreamPrincipal,
  loadDreamAgent,
  type RunRow,
  toRun,
} from "./rows.ts";
import type { Judge } from "./steps/judge.ts";
import { mergeNotes } from "./steps/merge.ts";
import { type ProcedureDraft, promoteProcedures } from "./steps/promote.ts";
import { pruneNotes } from "./steps/prune.ts";
import { reconcileNotes } from "./steps/reconcile.ts";

const DATE_LENGTH = 10;
/** A run still `running` after this long is taken for one that died. */
export const STALE_RUN_MS = 60 * 60_000;
const ERROR_MAX = 300;
const SKIPPED_DIARY = "Nothing happened since the last dream.";
const FAILED_DIARY = "The dream did not finish. Memory is unchanged.";
const ABANDONED = "The dream did not finish";
const MODEL_FAILED = "A model call failed";
/** Statuses after which the next dream starts reading where this one began. */
const ADVANCING = ["done", "skipped", "undone"] as const;

export interface RunDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "readPayload">;
  fetch: Fetcher;
  library: DreamMemoryLibrary;
  managedKeys: Pick<ManagedKeysService, "resolve">;
  skillsStore: Pick<SkillsStoreService, "list" | "proposeForAgent">;
}

const countsOf = (plan: DreamPlan): DreamCounts => ({
  added: plan.filter((change) => change.action === "add").length,
  dropped: plan.filter((change) => change.action === "drop").length,
  merged: plan.filter((change) => change.action === "merge").length,
  questions: plan.filter((change) => change.action === "question").length,
});

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX);

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** A dream that failed, with what its model calls cost before it did. */
class DreamFailure extends Error {
  override readonly cause: unknown;
  readonly usage: DreamUsage | null;

  constructor(cause: unknown, usage: DreamUsage | null) {
    super(messageOf(cause));
    this.cause = cause;
    this.usage = usage;
  }
}

/**
 * Prunes each scope against the memory prompt budget it shares: a person's
 * prompt holds the shared notes and that person's private notes, so the shared
 * notes are pruned first and each person's own notes get what is left.
 */
const pruneByScope = async ({
  adds,
  held,
  judge,
  notes,
  today,
}: {
  adds: DreamPlan;
  held: readonly string[];
  judge: Judge;
  notes: readonly MemoryNote[];
  today: string;
}): Promise<{ changes: DreamPlan; notes: MemoryNote[] }> => {
  const addedBy = (scope: string | null): number =>
    adds.reduce(
      (sum, change) =>
        sum +
        (change.action === "add" && change.userScope === scope
          ? change.text.length
          : 0),
      0
    );
  const prune = (scope: string | null, maxChars: number) =>
    pruneNotes({
      held,
      judge,
      maxChars: Math.max(0, maxChars),
      notes: notes.filter((note) => note.userScope === scope),
      today,
    });
  const shared = await prune(null, MEMORY_PROMPT_MAX_CHARS - addedBy(null));
  const owners = [...new Set(notes.flatMap((note) => note.userScope ?? []))];
  const privates = await Promise.all(
    owners.map((owner) =>
      prune(
        owner,
        MEMORY_PROMPT_MAX_CHARS - shared.chars - addedBy(null) - addedBy(owner)
      )
    )
  );
  const results = [shared, ...privates];
  return {
    changes: results.flatMap((result) => result.changes),
    notes: results.flatMap((result) => result.notes),
  };
};

export const createDreamRunner = (deps: RunDeps) => {
  const { atomic, clock, db, library } = deps;
  const collector = createDreamCollector({
    db,
    events: deps.events,
  });

  const runRow = async (id: string): Promise<RunRow> => {
    const [row] = await db
      .select()
      .from(dreamRuns)
      .where(eq(dreamRuns.id, id))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", `No dream run "${id}"`);
    }
    return row;
  };

  /** Where the next dream starts reading: the start of the last one that moved on. */
  const sinceOf = async (agentId: string): Promise<string | null> => {
    const [last] = await db
      .select({ startedAt: dreamRuns.startedAt })
      .from(dreamRuns)
      .where(
        and(
          eq(dreamRuns.agentId, agentId),
          inArray(dreamRuns.status, [...ADVANCING])
        )
      )
      .orderBy(desc(dreamRuns.startedAt))
      .limit(1);
    return last?.startedAt ?? null;
  };

  /** Runs that died while `running` become `failed`; a live one blocks a second dream. */
  const claim = async (agentId: string, now: Date): Promise<void> => {
    const cutoff = new Date(now.getTime() - STALE_RUN_MS).toISOString();
    await db
      .update(dreamRuns)
      .set({
        error: ABANDONED,
        finishedAt: now.toISOString(),
        status: "failed",
      })
      .where(
        and(
          eq(dreamRuns.agentId, agentId),
          eq(dreamRuns.status, "running"),
          lt(dreamRuns.startedAt, cutoff)
        )
      );
    const [live] = await db
      .select({ id: dreamRuns.id })
      .from(dreamRuns)
      .where(
        and(eq(dreamRuns.agentId, agentId), eq(dreamRuns.status, "running"))
      )
      .limit(1);
    if (live) {
      throw new ServiceError("conflict", "This agent is already dreaming");
    }
  };

  const finish = (
    runId: string,
    fields: Partial<typeof dreamRuns.$inferInsert>
  ): Statement =>
    db
      .update(dreamRuns)
      .set({ finishedAt: clock.now().toISOString(), ...fields })
      .where(eq(dreamRuns.id, runId));

  /** Open questions of the agent, as the sets of note ids they ask about. */
  const openQuestionSets = async (agentId: string): Promise<string[][]> => {
    const rows = await db
      .select({ options: dreamQuestions.options })
      .from(dreamQuestions)
      .where(
        and(
          eq(dreamQuestions.agentId, agentId),
          eq(dreamQuestions.status, "open")
        )
      );
    return rows.map((row) => {
      try {
        const parsed = JSON.parse(row.options) as { noteId: string }[];
        return parsed.map((option) => option.noteId);
      } catch {
        return [];
      }
    });
  };

  const questionStatements = (
    agent: DreamAgent,
    runId: string,
    plan: DreamPlan,
    notes: ReadonlyMap<string, MemoryNote>
  ): Statement[] =>
    plan.flatMap((change) => {
      if (change.action !== "question") {
        return [];
      }
      const asked = change.noteIds.flatMap((id) => notes.get(id) ?? []);
      const scope = asked[0]?.userScope ?? null;
      if (asked.length < 2 || asked.some((note) => note.userScope !== scope)) {
        return [];
      }
      return [
        db.insert(dreamQuestions).values({
          agentId: agent.id,
          createdAt: clock.now().toISOString(),
          dreamRunId: runId,
          id: ulid(),
          options: storeOptions(
            asked.map((note) => ({ noteId: note.id, text: note.text })),
            scope
          ),
          question: change.question,
          status: "open",
          workspaceId: agent.workspaceId,
        }),
      ];
    });

  interface Outcome {
    /** The notes once the plan applies, so a question shows the text a merge left. */
    notes: MemoryNote[];
    outside: boolean;
    plan: DreamPlan;
    proposals: ProcedureDraft[];
  }

  /** The model's work: candidates, then merge, reconcile and prune, each on the last one's notes. */
  const think = async (
    agent: DreamAgent,
    items: Parameters<typeof extractCandidates>[0]["items"],
    notes: MemoryNote[],
    apiKey: string,
    today: string,
    existingNames: string[] | null
  ): Promise<Outcome & { usage: DreamUsage }> => {
    const model = createDreamModel({ apiKey, fetch: deps.fetch });
    try {
      const extracted = await extractCandidates({
        // A rejected skill proposal is evidence for `promote` only. Notes made
        // from it are noise ("a skill was rejected"), so extraction never sees it.
        items: items.filter((item) => item.kind !== "skill_proposal"),
        judge: model.judge,
        never: [...agent.workspaceNever, ...agent.rules.never],
        remember: agent.rules.remember,
      });
      const merged = await mergeNotes({
        candidates: extracted.candidates,
        judge: model.judge,
        notes,
        today,
      });
      const reconciled = await reconcileNotes({
        judge: model.judge,
        notes: merged.notes,
      });
      const pruned = await pruneByScope({
        adds: merged.changes,
        held: reconciled.held,
        judge: model.judge,
        notes: reconciled.notes,
        today,
      });
      const rejected = items
        .filter((item) => item.kind === "skill_proposal")
        .flatMap((item) => {
          try {
            const parsed = JSON.parse(item.text) as {
              message?: unknown;
            } | null;
            return typeof parsed?.message === "string" ? [parsed.message] : [];
          } catch {
            return [];
          }
        });
      const proposals =
        existingNames === null
          ? []
          : await promoteProcedures({
              existingNames,
              items,
              judge: model.judge,
              rejected,
            });
      if (model.failedCalls() > 0) {
        throw new ServiceError("invalid", MODEL_FAILED);
      }
      return {
        notes: pruned.notes,
        outside: extracted.outside,
        plan: [...merged.changes, ...reconciled.changes, ...pruned.changes],
        proposals,
        usage: model.usage(),
      };
    } catch (error) {
      // Keep what the calls cost even when the dream fails.
      // biome-ignore lint/style/useErrorCause: DreamFailure holds the cause in its own field
      throw new DreamFailure(error, model.usage());
    }
  };

  const fileProposals = async (
    agent: DreamAgent,
    principal: Principal,
    drafts: readonly ProcedureDraft[],
    items: Parameters<typeof promoteProcedures>[0]["items"]
  ): Promise<(string | null)[]> => {
    const proposals: (string | null)[] = [];
    for (const draft of drafts) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: publish independently, retaining successful proposals
        await deps.skillsStore.proposeForAgent(principal, {
          agentId: agent.id,
          files: [{ content: draft.content, path: "SKILL.md" }],
          message: draft.title,
          name: draft.name,
        });
        // Conservatively redact a title when ANY cited evidence is not workspace-scoped.
        proposals.push(
          draft.evidence.every((id) =>
            items.some((item) => item.id === id && item.scope === "workspace")
          )
            ? draft.title
            : null
        );
      } catch {
        // Another dream may have filed the name, or storage may be unavailable. Memory is safe.
      }
    }
    return proposals;
  };

  const dream = async (
    agent: DreamAgent,
    runId: string,
    since: string | null
  ): Promise<void> => {
    const today = clock.now().toISOString().slice(0, DATE_LENGTH);
    const collection = await collector.collectSince(agent.id, since);
    if (collection.items.length === 0) {
      await atomic([
        finish(runId, { diary: SKIPPED_DIARY, status: "skipped" }),
      ]);
      return;
    }
    const key = await deps.managedKeys.resolve(agent.workspaceId);
    if (!key) {
      throw new ServiceError("invalid", NO_KEY_MESSAGE);
    }
    const principal = dreamPrincipal(agent);
    const loaded = await loadEveryMemoryFile(library, principal, agent.slug);
    const [problem] = Object.entries(loaded.problems);
    if (problem) {
      throw new ServiceError("invalid", describeProblem(...problem));
    }
    // Retain names even when every version was rejected: rejection is not permission to refile.
    let existingNames: string[] | null = null;
    try {
      existingNames = (await deps.skillsStore.list(principal))
        .filter((skill) => skill.ownerAgentId === agent.id)
        .map((skill) => skill.name);
    } catch {
      // An unavailable skill store must not prevent the memory plan from being saved.
    }
    const thought = await think(
      agent,
      collection.items,
      loaded.notes,
      key.apiKey,
      today,
      existingNames
    );
    const usage = JSON.stringify(thought.usage);
    const known = await openQuestionSets(agent.id);
    // A question that is already open is not asked again.
    const plan = thought.plan.filter(
      (change) =>
        change.action !== "question" ||
        !known.some((ids) => sameIds(ids, change.noteIds))
    );
    const notes = new Map(loaded.notes.map((note) => [note.id, note]));
    const counts = countsOf(plan);
    const held = agent.rules.learnLevel === "ask_first" || thought.outside;
    const diaryInput = {
      counts,
      held,
      noteText: (id: string) => {
        const note = notes.get(id);
        return note && note.userScope === null ? note.text : null;
      },
      plan,
    };
    const diary = writeDiary(diaryInput);
    const rows = rowsFromPlan(plan, {
      agentId: agent.id,
      createdAt: clock.now().toISOString(),
      notes,
      runId,
      status: held ? "held" : "applied",
      workspaceId: agent.workspaceId,
    });
    // A held batch is not in memory yet, so its questions show the notes as they are now.
    const questions = questionStatements(
      agent,
      runId,
      plan,
      held ? notes : new Map(thought.notes.map((note) => [note.id, note]))
    );
    await store({
      agent,
      held,
      loaded,
      principal,
      questions,
      rows,
      runId,
      summary: {
        counts: JSON.stringify(counts),
        diary,
        status: "done" as const,
        usage,
      },
      today,
    });
    // Skills always ask a person, independently of a held memory batch or learn level.
    // Store memory first so a publication failure cannot discard or fail its plan.
    const proposals = await fileProposals(
      agent,
      principal,
      thought.proposals,
      collection.items
    );
    if (proposals.length > 0) {
      try {
        await db
          .update(dreamRuns)
          .set({
            diary: writeDiary({ ...diaryInput, proposals }),
          })
          .where(eq(dreamRuns.id, runId));
      } catch {
        // A diary write failure after publishing must not turn the stored memory plan into a failure.
      }
    }
  };

  interface Store {
    agent: DreamAgent;
    held: boolean;
    loaded: LoadedMemory;
    principal: Principal;
    questions: Statement[];
    rows: ReturnType<typeof rowsFromPlan>;
    runId: string;
    summary: Partial<typeof dreamRuns.$inferInsert> & { status: "done" };
    today: string;
  }

  /** Writes the plan: the rows and files together, or only the rows for a held batch or a plan with no note changes. */
  const store = async ({
    agent,
    held,
    loaded,
    principal,
    questions,
    rows,
    runId,
    summary,
    today,
  }: Store): Promise<void> => {
    if (rows.length === 0 || held) {
      // A held batch records the files it was made against. Approving it later
      // is refused when any of them has changed since.
      const against = held
        ? [...new Set(rows.map(pathOfRow))].flatMap(
            (path) => loaded.versionIds?.[path] ?? []
          )
        : [];
      await atomic([
        ...rows.map((row) => db.insert(memoryChanges).values(row)),
        ...questions,
        finish(runId, { ...summary, baseVersion: JSON.stringify(against) }),
      ]);
      return;
    }
    let next: Record<string, string>;
    try {
      next = applyRows(loaded.files, rows, today);
    } catch (error) {
      if (error instanceof MemoryCodecError) {
        // biome-ignore lint/style/useErrorCause: ServiceError has no cause parameter
        throw new ServiceError("conflict", error.message);
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
          db.insert(memoryChanges).values({
            ...row,
            libraryVersionId: written.versionByPath.get(pathOfRow(row)) ?? null,
          })
        ),
        ...questions,
        finish(runId, {
          ...summary,
          baseVersion: JSON.stringify(written.baseVersion),
          resultVersion: written.resultVersion,
        }),
      ],
    });
  };

  /**
   * Runs one dream for the agent, now. The run row exists before any work, so
   * a dream that dies is still on record. A dream that fails is a `failed` run,
   * not an error: it returns normally. Only a dream that could not start
   * (the agent is already dreaming) throws.
   */
  const run = async (agentId: string): Promise<DreamRun> => {
    const agent = await loadDreamAgent(db, agentId);
    // A paused agent starts nothing, a dream included. No run is recorded, so
    // the next dream still reads everything since the last one.
    if (agent.pausedAt !== null) {
      throw new ServiceError(
        "conflict",
        `${agent.name} is paused, so it does not dream`
      );
    }
    const now = clock.now();
    await claim(agent.id, now);
    const runId = ulid();
    await db.insert(dreamRuns).values({
      agentId: agent.id,
      id: runId,
      since: await sinceOf(agent.id),
      startedAt: now.toISOString(),
      status: "running",
      workspaceId: agent.workspaceId,
    });
    const started = await runRow(runId);
    try {
      await dream(agent, runId, started.since);
    } catch (error) {
      const failure =
        error instanceof DreamFailure ? error : new DreamFailure(error, null);
      await atomic([
        finish(runId, {
          diary: FAILED_DIARY,
          error: messageOf(failure.cause),
          status: "failed",
          usage: failure.usage ? JSON.stringify(failure.usage) : null,
        }),
      ]);
    }
    return toRun(await runRow(runId));
  };

  return { run };
};
