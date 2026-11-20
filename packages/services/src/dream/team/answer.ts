// A person's answer to a team dream's question. The owner keeps one member's
// note, and every other member that holds a disagreeing note is updated: its
// note takes the kept text. A second note of the same member that holds the
// kept one is forgotten instead. The writes go through the files layer as the
// person who answered, because the team owner need not own each member, and
// land in one library call with the closed question. They carry no dream run,
// so undoing the team dream never reverts a person's decision.
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { dreamQuestions } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import type { MemoryNote } from "@repo/db/shared";
import { and, eq, inArray } from "drizzle-orm";
import { monotonicFactory } from "ulidx";
import { ServiceError } from "../../errors.ts";
import {
  apply,
  MemoryCodecError,
  type MemoryFiles,
} from "../../memory/codec.ts";
import {
  commitFolderFiles,
  type FolderWrite,
  type LoadedMemory,
  loadMemory,
  type MemoryLibrary,
} from "../../memory/files.ts";
import type { Clock } from "../../runs/types.ts";
import type { Principal } from "../../workspaces.ts";
import { readHolders, readOptions } from "../question-options.ts";
import type { QuestionRow } from "../rows.ts";
import { sourceColumns } from "./team.ts";

const DATE_LENGTH = 10;

export interface TeamAnswerDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  library: MemoryLibrary;
}

type ChangeRow = typeof memoryChanges.$inferInsert;

const nextRowId = monotonicFactory();

const stale = () =>
  new ServiceError(
    "conflict",
    "A note in this question changed since it was asked. Ask the team to dream again."
  );

type Memories = ReadonlyMap<string, { loaded: LoadedMemory; slug: string }>;

/** The notes the question asks about, by member: who holds each, and each member's files as they are now. */
const loadMembers = async (
  db: Database,
  library: MemoryLibrary,
  principal: Principal,
  row: QuestionRow,
  agentIds: readonly string[]
): Promise<Memories> => {
  const found = await db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, row.workspaceId),
        inArray(agents.id, [...agentIds])
      )
    );
  const loaded = await Promise.all(
    found.map(
      async (agent) =>
        [
          agent.id,
          {
            loaded: await loadMemory(library, principal, agent.slug, null),
            slug: agent.slug,
          },
        ] as const
    )
  );
  return new Map(loaded);
};

interface Plan {
  files: Map<string, MemoryFiles>;
  rows: { path: string; row: ChangeRow }[];
}

/**
 * The files after the answer: every other note takes the kept note's text, or
 * is forgotten when the kept note's own member holds it too.
 */
const planAnswer = (input: {
  holders: ReadonlyMap<string, string>;
  keptNoteId: string;
  memories: Memories;
  noteIds: readonly string[];
  now: string;
  userId: string;
  workspaceId: string;
}): Plan => {
  const { holders, keptNoteId, memories, now } = input;
  const noteOf = (noteId: string): MemoryNote | undefined => {
    const agentId = holders.get(noteId);
    const key = noteId.toUpperCase();
    return agentId === undefined
      ? undefined
      : memories
          .get(agentId)
          ?.loaded.notes.find((note) => note.id.toUpperCase() === key);
  };
  const kept = noteOf(keptNoteId);
  const keptHolder = holders.get(keptNoteId);
  if (!(kept && keptHolder)) {
    throw stale();
  }
  const files = new Map<string, MemoryFiles>(
    [...memories].map(([agentId, memory]) => [agentId, memory.loaded.files])
  );
  const rows: Plan["rows"] = [];
  for (const noteId of input.noteIds.filter((id) => id !== keptNoteId)) {
    const note = noteOf(noteId);
    const agentId = holders.get(noteId);
    const slug =
      agentId === undefined ? undefined : memories.get(agentId)?.slug;
    const current = agentId === undefined ? undefined : files.get(agentId);
    if (!(note && agentId && slug && current)) {
      // Forgotten or gone already, by an earlier try of this same answer.
      continue;
    }
    const sameHolder = agentId === keptHolder;
    files.set(
      agentId,
      apply(
        current,
        sameHolder
          ? { action: "forget", noteId: note.id }
          : {
              action: "edit",
              date: now.slice(0, DATE_LENGTH),
              noteId: note.id,
              text: kept.text,
              writtenBy: "person",
            }
      )
    );
    rows.push({
      path: `agents/${slug}/memory/${note.kind}.md`,
      row: {
        action: sameHolder ? "forget" : "edit",
        agentId,
        createdAt: now,
        decidedAt: now,
        decidedBy: input.userId,
        dreamRunId: null,
        groupId: null,
        id: nextRowId(),
        kind: note.kind,
        libraryVersionId: null,
        noteId: note.id,
        ...sourceColumns(note.source),
        status: "applied",
        teamId: null,
        text: sameHolder ? note.text : kept.text,
        userScope: null,
        workspaceId: input.workspaceId,
        writtenBy: "person",
      },
    });
  }
  return { files, rows };
};

/** The files that differ from what was read, with the etag each was read at. */
const writesOf = (plan: Plan, memories: Memories): FolderWrite[] =>
  [...plan.files].flatMap(([agentId, next]) => {
    const memory = memories.get(agentId);
    if (!memory) {
      return [];
    }
    return Object.entries(next).flatMap(([path, text]) =>
      text === memory.loaded.texts[path]
        ? []
        : [
            {
              ifEtag: memory.loaded.etags[path],
              path: `agents/${memory.slug}/memory/${path}`,
              text,
            },
          ]
    );
  });

export const createTeamAnswer = ({
  atomic,
  clock,
  db,
  library,
}: TeamAnswerDeps) => {
  const answer = async (
    principal: Extract<Principal, { kind: "user" }>,
    row: QuestionRow,
    keptNoteId: string
  ): Promise<void> => {
    const holders = readHolders(row.options);
    const memories = await loadMembers(db, library, principal, row, [
      ...new Set(holders.values()),
    ]);
    const now = clock.now().toISOString();
    let plan: Plan;
    try {
      plan = planAnswer({
        holders,
        keptNoteId,
        memories,
        noteIds: readOptions(row.options).options.map((o) => o.noteId),
        now,
        userId: principal.userId,
        workspaceId: row.workspaceId,
      });
    } catch (error) {
      if (error instanceof MemoryCodecError) {
        throw stale();
      }
      throw error;
    }
    const close = () =>
      db
        .update(dreamQuestions)
        .set({
          answeredAt: now,
          answeredBy: principal.userId,
          answeredNoteId: keptNoteId,
          status: "answered",
        })
        .where(
          and(eq(dreamQuestions.id, row.id), eq(dreamQuestions.status, "open"))
        );
    const writes = writesOf(plan, memories);
    if (writes.length === 0) {
      await atomic([close()]);
      return;
    }
    await commitFolderFiles({
      library,
      principal,
      statements: (written) => [
        ...plan.rows.map(({ path, row: change }) =>
          db.insert(memoryChanges).values({
            ...change,
            libraryVersionId: written.versionByPath.get(path) ?? null,
          })
        ),
        close(),
      ],
      writes,
    });
  };

  return { answer };
};
