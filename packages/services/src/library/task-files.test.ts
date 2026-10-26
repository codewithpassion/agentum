import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import {
  libraryConflicts as conflictRows,
  libraryVersions as versionRows,
} from "@repo/db/schema/library";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { and, eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { createEventsService } from "../events.ts";
import { createLibraryService } from "../library.ts";
import { systemClock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { type MemoryLibraryBlobs, memoryLibraryBlobs } from "./memory.ts";
import { createTaskFiles } from "./task-files.ts";

const A = "w1";
const B = "w2";
const START = "2026-10-16T10:00:00.000Z";
const AGENT = "a1";
const OTHER_AGENT = "a2";
const SESSION = "s1";
const PRIVATE_SESSION = "s2";
const OTHER_SESSION = "s3";
const RUN = "r1";
const SECOND_RUN = "r2";
const OTHER_RUN = "r3";
const PRIVATE_RUN = "r4";
const PREFIX_RUN = "r10";

const user = (workspaceId = A, userId = "u1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const runPrincipal = (agentId: string, runId: string): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: A,
});

let db: ReturnType<typeof migrated>;
let blobs: MemoryLibraryBlobs;
let library: ReturnType<typeof createLibraryService>;
let taskFiles: ReturnType<typeof createTaskFiles>["taskFiles"];

const bytes = (value: string) => new TextEncoder().encode(value);

const seedAgent = (id: string, slug: string) =>
  db
    .insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id,
      instructions: "",
      model: "m",
      name: slug,
      runtime: "fake",
      runtimeConfig: "{}",
      slug,
      status: "active",
      workspaceId: A,
    })
    .run();

const seedSession = (id: string, agentId: string, actorId: string) =>
  db
    .insert(sessionRows)
    .values({
      actorId,
      actorKind: "user",
      agentId,
      createdAt: START,
      id,
      origin: "ui",
      workspaceId: A,
    })
    .run();

const seedRun = (id: string, sessionId: string, agentId: string) =>
  db
    .insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId,
      createdAt: START,
      id,
      inputFileIds: "[]",
      inputText: "hi",
      outputFileIds: "[]",
      sessionId,
      status: "running",
      workspaceId: A,
    })
    .run();

const seedConflict = (values: {
  agentId: string;
  conflictPath: string;
  createdAt: string;
  id: string;
  path: string;
  runId: string;
  status: "open" | "resolved";
}) =>
  db
    .insert(conflictRows)
    .values({
      ...values,
      resolution: values.status === "resolved" ? "kept" : null,
      resolvedAt: values.status === "resolved" ? START : null,
      workspaceId: A,
    })
    .run();

beforeEach(() => {
  db = migrated();
  blobs = memoryLibraryBlobs();
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  library = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events: eventsService,
  });
  ({ taskFiles } = createTaskFiles({ db }));

  for (const id of [A, B]) {
    db.insert(workspaceRows)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: START,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  seedAgent(AGENT, "agent");
  seedAgent(OTHER_AGENT, "other");
  seedSession(SESSION, AGENT, "u1");
  seedSession(PRIVATE_SESSION, AGENT, "u2");
  seedSession(OTHER_SESSION, OTHER_AGENT, "u1");
  seedRun(RUN, SESSION, AGENT);
  seedRun(SECOND_RUN, SESSION, AGENT);
  seedRun(OTHER_RUN, OTHER_SESSION, OTHER_AGENT);
  seedRun(PRIVATE_RUN, PRIVATE_SESSION, AGENT);
  seedRun(PREFIX_RUN, SESSION, AGENT);
});

test("lists every entry under the task folder at any depth, in path order", async () => {
  const runs = runPrincipal(AGENT, RUN);
  await library.write(runs, `agents/agent/tasks/${RUN}/report.md`, bytes("r"));
  await library.write(
    runs,
    `agents/agent/tasks/${RUN}/out/deep/data.csv`,
    bytes("d")
  );

  const files = await taskFiles(user(), RUN);

  expect(files.folder).toBe(`agents/agent/tasks/${RUN}`);
  expect(files.entries.map(({ path, kind }) => [path, kind])).toEqual([
    [`agents/agent/tasks/${RUN}/out`, "dir"],
    [`agents/agent/tasks/${RUN}/out/deep`, "dir"],
    [`agents/agent/tasks/${RUN}/out/deep/data.csv`, "file"],
    [`agents/agent/tasks/${RUN}/report.md`, "file"],
  ]);
});

test("lists the run's outside edits at their latest version, and no person's", async () => {
  const runs = runPrincipal(AGENT, RUN);
  await library.write(runs, "agents/agent/notes.md", bytes("v1"));
  await library.write(runs, "agents/agent/notes.md", bytes("v2!"));
  await library.write(
    runs,
    `agents/agent/tasks/${PREFIX_RUN}/x.md`,
    bytes("x")
  );
  await library.write(user(), "agents/agent/person.md", bytes("p"));

  const files = await taskFiles(user(), RUN);

  const latestNotes = db
    .select()
    .from(versionRows)
    .where(
      and(
        eq(versionRows.path, "agents/agent/notes.md"),
        eq(versionRows.version, 2)
      )
    )
    .get();
  expect(files.outside).toEqual([
    {
      createdAt: expect.any(String),
      op: "write",
      path: "agents/agent/notes.md",
      size: 3,
      version: 2,
      versionId: latestNotes?.id,
    },
    {
      createdAt: expect.any(String),
      op: "write",
      path: `agents/agent/tasks/${PREFIX_RUN}/x.md`,
      size: 1,
      version: 1,
      versionId: expect.any(String),
    },
  ]);
  expect(files.entries).toEqual([]);
});

test("a delete the run made outside the folder is listed as a tombstone", async () => {
  const runs = runPrincipal(AGENT, RUN);
  await library.write(runs, "agents/agent/gone.md", bytes("g"));
  await library.remove(runs, "agents/agent/gone.md");

  const files = await taskFiles(user(), RUN);

  expect(files.outside).toMatchObject([
    { op: "delete", path: "agents/agent/gone.md", version: 2 },
  ]);
});

test("lists only open conflicts of the run, oldest first", async () => {
  seedConflict({
    agentId: AGENT,
    conflictPath: "agents/agent/a.conflict-r1",
    createdAt: "2026-10-16T12:00:00.000Z",
    id: "c-late",
    path: "agents/agent/a.md",
    runId: RUN,
    status: "open",
  });
  seedConflict({
    agentId: AGENT,
    conflictPath: "agents/agent/b.conflict-r1",
    createdAt: "2026-10-16T11:00:00.000Z",
    id: "c-early",
    path: "agents/agent/b.md",
    runId: RUN,
    status: "open",
  });
  seedConflict({
    agentId: AGENT,
    conflictPath: "agents/agent/c.conflict-r1",
    createdAt: "2026-10-16T11:30:00.000Z",
    id: "c-resolved",
    path: "agents/agent/c.md",
    runId: RUN,
    status: "resolved",
  });

  const files = await taskFiles(user(), RUN);

  expect(files.conflicts).toEqual([
    {
      conflictPath: "agents/agent/b.conflict-r1",
      createdAt: "2026-10-16T11:00:00.000Z",
      id: "c-early",
      path: "agents/agent/b.md",
    },
    {
      conflictPath: "agents/agent/a.conflict-r1",
      createdAt: "2026-10-16T12:00:00.000Z",
      id: "c-late",
      path: "agents/agent/a.md",
    },
  ]);
});

test("another run of the same agent or of another agent shows in none of the task's lists", async () => {
  const first = runPrincipal(AGENT, RUN);
  const second = runPrincipal(AGENT, SECOND_RUN);
  const other = runPrincipal(OTHER_AGENT, OTHER_RUN);
  await library.write(first, `agents/agent/tasks/${RUN}/mine.md`, bytes("1"));
  await library.write(first, "agents/agent/shared.md", bytes("1"));
  await library.write(
    second,
    `agents/agent/tasks/${SECOND_RUN}/theirs.md`,
    bytes("2")
  );
  await library.write(second, "agents/agent/second.md", bytes("2"));
  await library.write(
    other,
    `agents/other/tasks/${OTHER_RUN}/alien.md`,
    bytes("3")
  );
  await library.write(other, "agents/other/alien.md", bytes("3"));
  seedConflict({
    agentId: AGENT,
    conflictPath: "agents/agent/x.conflict-r2",
    createdAt: START,
    id: "c-second",
    path: "agents/agent/x.md",
    runId: SECOND_RUN,
    status: "open",
  });
  seedConflict({
    agentId: OTHER_AGENT,
    conflictPath: "agents/other/y.conflict-r3",
    createdAt: START,
    id: "c-other",
    path: "agents/other/y.md",
    runId: OTHER_RUN,
    status: "open",
  });

  const files = await taskFiles(user(), RUN);

  expect(files.entries.map((entry) => entry.path)).toEqual([
    `agents/agent/tasks/${RUN}/mine.md`,
  ]);
  expect(files.outside.map((edit) => edit.path)).toEqual([
    "agents/agent/shared.md",
  ]);
  expect(files.conflicts).toEqual([]);

  const secondFiles = await taskFiles(user(), SECOND_RUN);
  expect(secondFiles.entries.map((entry) => entry.path)).toEqual([
    `agents/agent/tasks/${SECOND_RUN}/theirs.md`,
  ]);
  expect(secondFiles.outside.map((edit) => edit.path)).toEqual([
    "agents/agent/second.md",
  ]);
  expect(secondFiles.conflicts.map((conflict) => conflict.id)).toEqual([
    "c-second",
  ]);

  const otherFiles = await taskFiles(user(), OTHER_RUN);
  expect(otherFiles.folder).toBe(`agents/other/tasks/${OTHER_RUN}`);
  expect(otherFiles.entries.map((entry) => entry.path)).toEqual([
    `agents/other/tasks/${OTHER_RUN}/alien.md`,
  ]);
  expect(otherFiles.outside.map((edit) => edit.path)).toEqual([
    "agents/other/alien.md",
  ]);
  expect(otherFiles.conflicts.map((conflict) => conflict.id)).toEqual([
    "c-other",
  ]);
});

test("a run in another member's private session is not found, and so is a run in another workspace", async () => {
  await expect(taskFiles(user(), PRIVATE_RUN)).rejects.toMatchObject({
    code: "not_found",
    message: "Task not found",
  });
  await expect(taskFiles(user(B), RUN)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(taskFiles(user(), "missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("a non-user principal is forbidden", async () => {
  await expect(taskFiles(runPrincipal(AGENT, RUN), RUN)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});
