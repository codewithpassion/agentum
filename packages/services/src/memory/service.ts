import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { memoryChanges } from "@repo/db/schema/memory";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  DREAM_SCHEDULES,
  LEARN_LEVELS,
  MEMORY_CHANGE_STATUSES,
  MEMORY_NOTE_KINDS,
  MEMORY_NOTE_MAX_CHARS,
  MEMORY_SOURCE_KINDS,
  type MemoryChange,
  type MemoryNote,
  type MemoryRules,
  type RememberRules,
} from "@repo/db/shared";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import { syncDreamTriggers } from "../dream/trigger.ts";
import { invalid, isServiceError, notFound, ServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import {
  effectiveOwner,
  readableWorkspace,
  requireSession,
} from "../guards.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { type MemoryFileChange, parseMemoryFile } from "./codec.ts";
import {
  commitChange,
  describeProblem,
  findNote,
  type LoadedMemory,
  loadMemory,
  type MemoryLibrary,
  pathOfNote,
} from "./files.ts";
import { findSecret, neverEntryIn } from "./guards.ts";
import {
  createMemoryActors,
  isUserId,
  MEMORY_KIND,
  MEMORY_READ,
  MEMORY_WRITE,
  type MemoryActor,
  type Provenance,
} from "./provenance.ts";

const MEMORY_RULES_WRITE = "memory.rules.write";
const MAX_ATTEMPTS = 3;
const CHANGES_LIMIT = 500;
const DATE_LENGTH = 10;

const MAX_RULE_ENTRIES = 50;
const MAX_RULE_CHARS = 200;

const agentIdSchema = z.string().min(1);
const noteKindSchema = z.enum(MEMORY_NOTE_KINDS);
const WHITESPACE_RUN = /\s+/g;
// A note is one line: line breaks and runs of whitespace become one space
// before the length is counted.
const noteTextSchema = z
  .string()
  .transform((text) => text.replace(WHITESPACE_RUN, " ").trim())
  .pipe(z.string().min(1).max(MEMORY_NOTE_MAX_CHARS));
const sourceSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(MEMORY_SOURCE_KINDS),
});
const ruleListSchema = z
  .array(z.string().trim().min(1).max(MAX_RULE_CHARS))
  .max(MAX_RULE_ENTRIES);

export const rememberRulesSchema = z.strictObject({
  dreamSchedule: z.enum(DREAM_SCHEDULES),
  learnLevel: z.enum(LEARN_LEVELS),
  never: ruleListSchema,
  remember: ruleListSchema,
  shareWithTeam: z.boolean(),
});

export const listInputSchema = z.strictObject({
  agentId: agentIdSchema,
  kind: noteKindSchema.optional(),
});

export const listTeamInputSchema = z.strictObject({
  kind: noteKindSchema.optional(),
  teamId: z.string().min(1),
});

/** The writer is the principal: a user adds as `person`, a run as `agent`. */
export const addInputSchema = z.strictObject({
  agentId: agentIdSchema,
  kind: noteKindSchema,
  source: sourceSchema.optional(),
  text: noteTextSchema,
});

export const editInputSchema = z.strictObject({
  agentId: agentIdSchema,
  noteId: z.string().min(1),
  text: noteTextSchema,
});

export const forgetInputSchema = z.strictObject({
  agentId: agentIdSchema,
  noteId: z.string().min(1),
});

export const decideInputSchema = z.strictObject({
  changeId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

export const undoInputSchema = z.strictObject({
  changeId: z.string().min(1),
});

export const changesInputSchema = z.strictObject({
  agentId: agentIdSchema,
  // ISO 8601 UTC. Only changes made at or after it.
  since: z.string().min(1).optional(),
  status: z.enum(MEMORY_CHANGE_STATUSES).optional(),
});

export const rulesGetInputSchema = z.strictObject({
  agentId: agentIdSchema,
});

export const rulesSetInputSchema = z.strictObject({
  agentId: agentIdSchema,
  rules: rememberRulesSchema,
});

export type RulesGetInput = z.infer<typeof rulesGetInputSchema>;
export type AddNoteInput = z.infer<typeof addInputSchema>;
export type EditNoteInput = z.infer<typeof editInputSchema>;
export type ForgetNoteInput = z.infer<typeof forgetInputSchema>;
export type DecideChangeInput = z.infer<typeof decideInputSchema>;
export type ChangesInput = z.infer<typeof changesInputSchema>;
export type ListNotesInput = z.infer<typeof listInputSchema>;
export type ListTeamInput = z.infer<typeof listTeamInputSchema>;
export type SetRulesInput = z.infer<typeof rulesSetInputSchema>;

export type ChangeRow = typeof memoryChanges.$inferSelect;
interface AgentInfo {
  id: string;
  ownerUserId: string;
  rules: RememberRules;
  slug: string;
  /** The workspace's never list, which every agent in it inherits. */
  workspaceNever: string[];
}

const clone = <T>(value: T): T => structuredClone(value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** The stored rules, or the defaults when the column holds something else. */
const rulesFrom = (raw: string): RememberRules => {
  const parsed = rememberRulesSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : clone(DEFAULT_REMEMBER_RULES);
};

const neverFrom = (raw: string): string[] => {
  const parsed = z.array(z.string()).safeParse(parseJson(raw));
  return parsed.success ? parsed.data : [...DEFAULT_NEVER_REMEMBER];
};

/** The agent a change belongs to. A team change has none: the team dream (TX.2) decides and undoes those. */
const agentOf = (row: ChangeRow): string => {
  if (row.agentId === null) {
    throw new ServiceError(
      "invalid",
      "A team memory change is not decided here"
    );
  }
  return row.agentId;
};

export const toChange = (row: ChangeRow): MemoryChange => ({
  action: row.action,
  agentId: row.agentId,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  decidedBy: row.decidedBy,
  dreamRunId: row.dreamRunId,
  groupId: row.groupId,
  id: row.id,
  kind: row.kind,
  libraryVersionId: row.libraryVersionId,
  noteId: row.noteId,
  source:
    row.sourceKind && row.sourceId
      ? { id: row.sourceId, kind: row.sourceKind }
      : null,
  status: row.status,
  teamId: row.teamId,
  text: row.text,
  userScope: row.userScope,
  writtenBy: row.writtenBy,
});

/** The file change a held row asks for, written on `date` when it is approved. */
const approvedChange = (row: ChangeRow, date: string): MemoryFileChange => {
  if (row.action === "forget") {
    return { action: "forget", noteId: row.noteId };
  }
  if (row.action === "edit") {
    return {
      action: "edit",
      date,
      noteId: row.noteId,
      text: row.text,
      writtenBy: row.writtenBy,
    };
  }
  return {
    action: "add",
    note: {
      date,
      id: row.noteId,
      kind: row.kind,
      source: toChange(row).source,
      text: row.text,
      userScope: row.userScope,
      writtenBy: row.writtenBy,
    },
  };
};

/** What a write does to one note, before the learn level and the guards pick its status. */
interface WritePlan {
  action: "add" | "edit" | "forget";
  change: MemoryFileChange;
  kind: MemoryNote["kind"];
  noteId: string;
  /** The file the note lives in, relative to the memory folder. */
  notePath: string;
  source: MemoryNote["source"];
  /** The note's text after the change. For a forget, the text that was forgotten. */
  text: string;
  userScope: string | null;
}

const refuseSecret = (text: string): void => {
  const found = findSecret(text);
  if (found) {
    throw invalid(
      `This note looks like it holds a secret (${found}), so it was not kept. Notes never hold keys, tokens, passwords or card numbers.`
    );
  }
};

/** A note that mentions an entry of a never list. It carries the plan, so the refusal can be recorded. */
class NeverListRefusal extends Error {
  readonly entry: string;
  readonly list: "agent" | "workspace";
  readonly plan: WritePlan;

  constructor(plan: WritePlan, entry: string, list: "agent" | "workspace") {
    super(
      `This note was not kept. It mentions "${entry}", which is on ${list === "workspace" ? "the workspace's" : "this agent's"} never-remember list. Leave that out.`
    );
    this.entry = entry;
    this.list = list;
    this.plan = plan;
  }
}

/** The never list entry a note's text mentions, the workspace's list first. */
const neverHitOf = (
  agent: AgentInfo,
  text: string
): { entry: string; list: "agent" | "workspace" } | null => {
  const workspaceEntry = neverEntryIn(text, agent.workspaceNever);
  if (workspaceEntry !== null) {
    return { entry: workspaceEntry, list: "workspace" };
  }
  const agentEntry = neverEntryIn(text, agent.rules.never);
  return agentEntry === null ? null : { entry: agentEntry, list: "agent" };
};

const missingNote = (loaded: LoadedMemory, noteId: string) => {
  const unreadable = Object.entries(loaded.problems).map(([path, problem]) =>
    describeProblem(path, problem)
  );
  return notFound([`No note "${noteId}"`, ...unreadable].join(". "));
};

export const createMemoryService = ({
  atomic,
  clock,
  db,
  events,
  library,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "insertStatement">;
  library: MemoryLibrary;
}) => {
  const actors = createMemoryActors({ db });
  const now = () => clock.now().toISOString();
  const today = () => now().slice(0, DATE_LENGTH);

  const loadAgent = async (
    workspaceId: string,
    agentId: string
  ): Promise<AgentInfo> => {
    const [row] = await db
      .select({
        createdBy: agents.createdBy,
        id: agents.id,
        ownerUserId: agents.ownerUserId,
        remember: agents.remember,
        slug: agents.slug,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1);
    if (!row) {
      throw notFound(`No agent "${agentId}"`);
    }
    const [workspace] = await db
      .select({ neverRemember: workspaces.neverRemember })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    return {
      id: row.id,
      ownerUserId: effectiveOwner(row),
      rules: rulesFrom(row.remember),
      slug: row.slug,
      workspaceNever: workspace
        ? neverFrom(workspace.neverRemember)
        : [...DEFAULT_NEVER_REMEMBER],
    };
  };

  /** The private file the caller sees, when its owner has a Clerk user id. */
  const visibleScope = (actor: MemoryActor): string | null =>
    isUserId(actor.userId) ? actor.userId : null;

  const load = (actor: MemoryActor, agent: AgentInfo) =>
    loadMemory(library, actor.principal, agent.slug, visibleScope(actor));

  const findChange = async (
    workspaceId: string,
    changeId: string,
    userId: string
  ): Promise<ChangeRow> => {
    const [row] = await db
      .select()
      .from(memoryChanges)
      .where(
        and(
          eq(memoryChanges.id, changeId),
          eq(memoryChanges.workspaceId, workspaceId)
        )
      )
      .limit(1);
    // Another person's private change reads as missing.
    if (!row || (row.userScope !== null && row.userScope !== userId)) {
      throw notFound(`No change "${changeId}"`);
    }
    if (row.action === "merge" || row.groupId !== null) {
      throw invalid("A merged change is decided and undone with its dream");
    }
    if (row.dreamRunId !== null) {
      throw invalid(
        "A change a dream made is decided and undone with its dream"
      );
    }
    return row;
  };

  const reread = async (workspaceId: string, changeId: string) => {
    const [row] = await db
      .select()
      .from(memoryChanges)
      .where(
        and(
          eq(memoryChanges.id, changeId),
          eq(memoryChanges.workspaceId, workspaceId)
        )
      )
      .limit(1);
    if (!row) {
      throw notFound(`No change "${changeId}"`);
    }
    return toChange(row);
  };

  /**
   * Runs `plan` against the files as they are now and writes the result. A file
   * that changed in between (the library's `conflict`) is read again, a few times.
   */
  const writeWithRetry = async (
    actor: MemoryActor,
    agent: AgentInfo,
    plan: (loaded: LoadedMemory) => {
      change: MemoryFileChange;
      notePath: string;
      statements: (libraryVersionId: string) => Statement[];
    }
  ): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each attempt must read the files the last one lost to
      const loaded = await load(actor, agent);
      // A refusal from the plan is final. Only the write can lose a race.
      const planned = plan(loaded);
      try {
        await commitChange({
          library,
          loaded,
          principal: actor.principal,
          slug: agent.slug,
          ...planned,
        });
        return;
      } catch (error) {
        const isStale = isServiceError(error) && error.code === "conflict";
        if (!isStale || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  };

  const changeRow = (
    actor: MemoryActor,
    agent: AgentInfo,
    plan: WritePlan,
    status: "applied" | "held" | "rejected",
    libraryVersionId: string | null
  ): ChangeRow => ({
    action: plan.action,
    agentId: agent.id,
    createdAt: now(),
    decidedAt: null,
    decidedBy: null,
    dreamRunId: null,
    groupId: null,
    id: ulid(),
    kind: plan.kind,
    libraryVersionId,
    noteId: plan.noteId,
    sourceId: plan.source?.id ?? null,
    sourceKind: plan.source?.kind ?? null,
    status,
    teamId: null,
    text: plan.text,
    userScope: plan.userScope,
    workspaceId: actor.workspaceId,
    writtenBy: actor.writer,
  });

  /**
   * Writes one change: a person's applies. An agent's is held when the level is
   * ask_first or its source is outside text. A held change writes only its row.
   * An applied one writes the files, a library version and its row in one call.
   */
  const place = async (
    actor: MemoryActor,
    agent: AgentInfo,
    provenance: Provenance,
    planOf: (loaded: LoadedMemory) => WritePlan
  ): Promise<MemoryChange> => {
    const held =
      actor.writer !== "person" &&
      (provenance.outside !== null || agent.rules.learnLevel === "ask_first");
    if (held) {
      const plan = planOf(await load(actor, agent));
      const row = changeRow(actor, agent, plan, "held", null);
      await atomic([db.insert(memoryChanges).values(row)]);
      return toChange(row);
    }
    let applied: ChangeRow | null = null;
    await writeWithRetry(actor, agent, (loaded) => {
      const plan = planOf(loaded);
      return {
        change: plan.change,
        notePath: plan.notePath,
        statements: (versionId) => {
          applied = changeRow(actor, agent, plan, "applied", versionId);
          return [db.insert(memoryChanges).values(applied)];
        },
      };
    });
    if (!applied) {
      throw invalid("The change was not recorded");
    }
    return toChange(applied);
  };

  /**
   * Puts one change through the never list, the learn level and the guards. A
   * note that mentions a never list entry is refused and recorded as a rejected
   * change. The row names the entry and leaves out the note's text, since the
   * topic is one the owner does not want kept. Anything else goes to `place`.
   */
  const submit = async (
    actor: MemoryActor,
    agent: AgentInfo,
    provenance: Provenance,
    planOf: (loaded: LoadedMemory) => WritePlan
  ): Promise<MemoryChange> => {
    const checkedPlanOf = (loaded: LoadedMemory): WritePlan => {
      const plan = planOf(loaded);
      const hit =
        plan.action === "forget" ? null : neverHitOf(agent, plan.text);
      if (hit) {
        throw new NeverListRefusal(plan, hit.entry, hit.list);
      }
      return plan;
    };
    try {
      return await place(actor, agent, provenance, checkedPlanOf);
    } catch (error) {
      if (!(error instanceof NeverListRefusal)) {
        throw error;
      }
      const refused: ChangeRow = {
        ...changeRow(actor, agent, error.plan, "rejected", null),
        decidedAt: now(),
        text: `Not kept: it mentions "${error.entry}" from the ${error.list === "workspace" ? "workspace's" : "agent's"} never list`,
      };
      await atomic([db.insert(memoryChanges).values(refused)]);
      throw invalid(error.message);
    }
  };

  const list = async (
    principal: Principal,
    input: ListNotesInput
  ): Promise<MemoryNote[]> => {
    const actor = await actors.actorFor(principal, "read", input.agentId);
    const agent = await loadAgent(actor.workspaceId, input.agentId);
    const { notes } = await load(actor, agent);
    return input.kind
      ? notes.filter((note) => note.kind === input.kind)
      : notes;
  };

  /**
   * Stub: no team note is listed. The team memory service task (TX.2) reads the
   * team's notes from `teams/<slug>/memory/`.
   */
  const listTeam = (
    principal: Principal,
    input: ListTeamInput
  ): Promise<MemoryNote[]> => {
    const workspaceId = readableWorkspace(principal, MEMORY_READ);
    authorize(principal, MEMORY_READ, {
      id: input.teamId,
      kind: MEMORY_KIND,
      workspaceId,
    });
    return Promise.resolve([]);
  };

  const add = async (
    principal: Principal,
    input: AddNoteInput
  ): Promise<MemoryChange> => {
    const actor = await actors.actorFor(principal, "write", input.agentId);
    const agent = await loadAgent(actor.workspaceId, input.agentId);
    refuseSecret(input.text);
    const provenance = await actors.provenanceOf(actor, agent.id, input.source);
    const noteId = ulid();
    return await submit(actor, agent, provenance, (loaded) => {
      const notePath = pathOfNote({
        kind: input.kind,
        userScope: provenance.userScope,
      });
      const problem = loaded.problems[notePath];
      if (problem) {
        throw invalid(describeProblem(notePath, problem));
      }
      const note: MemoryNote = {
        date: today(),
        id: noteId,
        kind: input.kind,
        source: provenance.source,
        text: input.text,
        userScope: provenance.userScope,
        writtenBy: actor.writer,
      };
      return {
        action: "add",
        change: { action: "add", note },
        kind: note.kind,
        noteId,
        notePath,
        source: note.source,
        text: note.text,
        userScope: note.userScope,
      };
    });
  };

  const edit = async (
    principal: Principal,
    input: EditNoteInput
  ): Promise<MemoryChange> => {
    const actor = await actors.actorFor(principal, "write", input.agentId);
    const agent = await loadAgent(actor.workspaceId, input.agentId);
    refuseSecret(input.text);
    const provenance = await actors.provenanceOf(actor, agent.id, undefined);
    return await submit(actor, agent, provenance, (loaded) => {
      const note = findNote(loaded, input.noteId);
      if (!note) {
        throw missingNote(loaded, input.noteId);
      }
      return {
        action: "edit",
        change: {
          action: "edit",
          date: today(),
          noteId: note.id,
          text: input.text,
          writtenBy: actor.writer,
        },
        kind: note.kind,
        noteId: note.id,
        notePath: pathOfNote(note),
        source: provenance.source ?? note.source,
        text: input.text,
        userScope: note.userScope,
      };
    });
  };

  const forget = async (
    principal: Principal,
    input: ForgetNoteInput
  ): Promise<MemoryChange> => {
    const actor = await actors.actorFor(principal, "write", input.agentId);
    const agent = await loadAgent(actor.workspaceId, input.agentId);
    const provenance = await actors.provenanceOf(actor, agent.id, undefined);
    return await submit(actor, agent, provenance, (loaded) => {
      const note = findNote(loaded, input.noteId);
      if (!note) {
        throw missingNote(loaded, input.noteId);
      }
      return {
        action: "forget",
        change: { action: "forget", noteId: note.id },
        kind: note.kind,
        noteId: note.id,
        notePath: pathOfNote(note),
        source: provenance.source ?? note.source,
        text: note.text,
        userScope: note.userScope,
      };
    });
  };

  /** The deciding person, as an actor that reads and writes the files the change touches. */
  const deciderOf = (
    principal: Principal,
    person: { userId: string; workspaceId: string }
  ): MemoryActor => ({
    principal,
    userId: person.userId,
    workspaceId: person.workspaceId,
    writer: "person",
  });

  const approve = async (
    actor: MemoryActor,
    agent: AgentInfo,
    row: ChangeRow
  ): Promise<void> => {
    await writeWithRetry(actor, agent, (loaded) => {
      const found = findNote(loaded, row.noteId);
      if (row.action === "add" && found) {
        throw new ServiceError("conflict", "That note is already in memory");
      }
      if (row.action !== "add" && !found) {
        throw new ServiceError("conflict", "That note is no longer in memory");
      }
      const change = approvedChange(row, today());
      return {
        change,
        notePath: pathOfNote(row),
        statements: (versionId) => [
          db
            .update(memoryChanges)
            .set({
              decidedAt: now(),
              decidedBy: actor.userId,
              libraryVersionId: versionId,
              status: "applied",
            })
            .where(
              and(
                eq(memoryChanges.id, row.id),
                eq(memoryChanges.workspaceId, row.workspaceId),
                eq(memoryChanges.status, "held")
              )
            ),
        ],
      };
    });
  };

  const decide = async (
    principal: Principal,
    input: DecideChangeInput
  ): Promise<MemoryChange> => {
    const person = actors.personFor(principal, MEMORY_WRITE);
    const row = await findChange(
      person.workspaceId,
      input.changeId,
      person.userId
    );
    if (row.status !== "held") {
      throw new ServiceError("conflict", "That change is already decided");
    }
    agentOf(row);
    if (input.decision === "reject") {
      await atomic([
        db
          .update(memoryChanges)
          .set({
            decidedAt: now(),
            decidedBy: person.userId,
            status: "rejected",
          })
          .where(
            and(
              eq(memoryChanges.id, row.id),
              eq(memoryChanges.workspaceId, row.workspaceId),
              eq(memoryChanges.status, "held")
            )
          ),
      ]);
    } else {
      const agent = await loadAgent(person.workspaceId, agentOf(row));
      await approve(deciderOf(principal, person), agent, row);
    }
    return await reread(person.workspaceId, row.id);
  };

  /** The note as it stood in the library version before the change wrote its file. */
  const priorNote = async (
    actor: MemoryActor,
    agent: AgentInfo,
    row: ChangeRow
  ): Promise<MemoryNote> => {
    const path = `agents/${agent.slug}/memory/${pathOfNote(row)}`;
    const versions = await library.versions(actor.principal, path);
    const at = versions.findIndex(
      (version) => version.id === row.libraryVersionId
    );
    const prior = at === -1 ? undefined : versions[at + 1];
    if (!prior) {
      throw invalid("The earlier version of that note is no longer kept");
    }
    const { bytes } = await library.readVersion(actor.principal, prior.id);
    const parsed = parseMemoryFile(
      pathOfNote(row),
      new TextDecoder().decode(bytes)
    );
    const note = parsed.ok
      ? parsed.notes.find(
          (item) => item.id.toUpperCase() === row.noteId.toUpperCase()
        )
      : undefined;
    if (!note) {
      throw invalid("The earlier version of that note cannot be read");
    }
    return note;
  };

  const staleNote = () =>
    new ServiceError("conflict", "The note changed after this change");

  /** The change that puts the note back, after checking it is still as the change left it. */
  const inverseOf = (
    row: ChangeRow,
    prior: MemoryNote | null,
    loaded: LoadedMemory
  ): MemoryFileChange => {
    const found = findNote(loaded, row.noteId);
    if (row.action === "add") {
      if (found?.text !== row.text) {
        throw staleNote();
      }
      return { action: "forget", noteId: row.noteId };
    }
    if (!prior) {
      throw invalid("The earlier version of that note is missing");
    }
    if (row.action === "forget") {
      if (found) {
        throw staleNote();
      }
      return { action: "add", note: prior };
    }
    if (found?.text !== row.text) {
      throw staleNote();
    }
    return {
      action: "edit",
      date: prior.date,
      noteId: row.noteId,
      text: prior.text,
      writtenBy: prior.writtenBy,
    };
  };

  const undo = async (
    principal: Principal,
    changeId: string
  ): Promise<MemoryChange> => {
    const person = actors.personFor(principal, MEMORY_WRITE);
    const row = await findChange(person.workspaceId, changeId, person.userId);
    if (row.status !== "applied") {
      throw new ServiceError(
        "conflict",
        "Only an applied change can be undone"
      );
    }
    const actor = deciderOf(principal, person);
    const agent = await loadAgent(person.workspaceId, agentOf(row));
    const prior =
      row.action === "add" ? null : await priorNote(actor, agent, row);
    await writeWithRetry(actor, agent, (loaded) => ({
      change: inverseOf(row, prior, loaded),
      notePath: pathOfNote(row),
      statements: () => [
        db
          .update(memoryChanges)
          .set({ decidedAt: now(), decidedBy: person.userId, status: "undone" })
          .where(
            and(
              eq(memoryChanges.id, row.id),
              eq(memoryChanges.workspaceId, row.workspaceId),
              eq(memoryChanges.status, "applied")
            )
          ),
      ],
    }));
    return await reread(person.workspaceId, row.id);
  };

  const changes = async (
    principal: Principal,
    input: ChangesInput
  ): Promise<MemoryChange[]> => {
    const actor = await actors.actorFor(principal, "read", input.agentId);
    await loadAgent(actor.workspaceId, input.agentId);
    const own = actor.userId
      ? or(
          isNull(memoryChanges.userScope),
          eq(memoryChanges.userScope, actor.userId)
        )
      : isNull(memoryChanges.userScope);
    const rows = await db
      .select()
      .from(memoryChanges)
      .where(
        and(
          eq(memoryChanges.workspaceId, actor.workspaceId),
          eq(memoryChanges.agentId, input.agentId),
          own,
          input.status ? eq(memoryChanges.status, input.status) : undefined,
          input.since ? gte(memoryChanges.createdAt, input.since) : undefined
        )
      )
      .orderBy(desc(memoryChanges.createdAt), desc(memoryChanges.id))
      .limit(CHANGES_LIMIT);
    return rows.map(toChange);
  };

  const rules = {
    get: async (
      principal: Principal,
      input: RulesGetInput
    ): Promise<MemoryRules> => {
      const actor = await actors.actorFor(principal, "read", input.agentId);
      const agent = await loadAgent(actor.workspaceId, input.agentId);
      const [workspace] = await db
        .select({ neverRemember: workspaces.neverRemember })
        .from(workspaces)
        .where(eq(workspaces.id, actor.workspaceId))
        .limit(1);
      return {
        agent: agent.rules,
        workspaceNever: workspace
          ? neverFrom(workspace.neverRemember)
          : [...DEFAULT_NEVER_REMEMBER],
      };
    },
    set: async (
      principal: Principal,
      input: SetRulesInput
    ): Promise<MemoryRules> => {
      const workspaceId = readableWorkspace(principal, MEMORY_RULES_WRITE);
      authorize(principal, MEMORY_RULES_WRITE, {
        id: input.agentId,
        kind: MEMORY_KIND,
        workspaceId,
      });
      // The owner or an org admin, on a browser session. A run, a key or a peer never.
      const user = requireSession(principal, MEMORY_RULES_WRITE);
      const agent = await loadAgent(workspaceId, input.agentId);
      if (user.isAdmin !== true && agent.ownerUserId !== user.userId) {
        throw new ForbiddenError(MEMORY_RULES_WRITE);
      }
      await atomic([
        db
          .update(agents)
          .set({ remember: JSON.stringify(input.rules) })
          .where(
            and(eq(agents.id, agent.id), eq(agents.workspaceId, workspaceId))
          ),
        events.insertStatement({
          actor: { id: user.userId, kind: "user" },
          agentId: agent.id,
          payload: { changed: ["remember"] },
          type: "agent.updated",
          workspaceId,
        }),
      ]);
      // The dream trigger follows the schedule. The minute tick repairs it if this fails.
      await syncDreamTriggers(db, clock.now(), agent.id);
      return await rules.get(principal, { agentId: agent.id });
    },
  };

  return { add, changes, decide, edit, forget, list, listTeam, rules, undo };
};

export type MemoryService = ReturnType<typeof createMemoryService>;
