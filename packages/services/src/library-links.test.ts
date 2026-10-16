import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { files as fileRows } from "@repo/db/schema/files";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { and, eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import { type MemoryFileBlobs, memoryFileBlobs } from "./files/memory.ts";
import { createFilesService } from "./files.ts";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { createLibraryLinksService } from "./library-links.ts";
import { systemClock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const A = "w1";
const B = "w2";
const START = "2026-10-16T10:00:00.000Z";

const user = (workspaceId = A, userId = "u1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const runPrincipal: Principal = {
  agentId: "a1",
  kind: "run",
  runId: "r1",
  workspaceId: A,
};
const machinePrincipal: Principal = {
  kind: "machine",
  machineId: "m1",
  workspaceId: A,
};

let db: ReturnType<typeof migrated>;
let fileBlobs: MemoryFileBlobs;
let libraryBlobs: MemoryLibraryBlobs;
let files: ReturnType<typeof createFilesService>;
let library: ReturnType<typeof createLibraryService>;
let links: ReturnType<typeof createLibraryLinksService>;

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const text = (value: string) => new Blob([value], { type: "text/plain" });
const readBody = (body: ReadableStream<Uint8Array>) =>
  new Response(body).text();

/** The error a promise rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

const insertWorkspace = (id: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const fileRowsIn = (workspaceId: string) =>
  db.select().from(fileRows).where(eq(fileRows.workspaceId, workspaceId)).all();

const libraryWrites = (workspaceId: string) =>
  db
    .select()
    .from(eventRows)
    .where(
      and(
        eq(eventRows.workspaceId, workspaceId),
        eq(eventRows.type, "library.write")
      )
    )
    .all();

beforeEach(() => {
  db = migrated();
  fileBlobs = memoryFileBlobs();
  libraryBlobs = memoryLibraryBlobs();
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  files = createFilesService({ blobs: fileBlobs, clock: systemClock, db });
  library = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs: libraryBlobs,
    clock: systemClock,
    db,
    events: eventsService,
  });
  links = createLibraryLinksService({ files, library });
  insertWorkspace(A);
  insertWorkspace(B);
});

/** An agent, a session and a run `r1` that lists `inputFileIds` as input. */
const insertRunWithInputs = (inputFileIds: string[]) => {
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: "a1",
      instructions: "",
      model: "m",
      name: "Agent",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "agent",
      status: "active",
      workspaceId: A,
    })
    .run();
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: START,
      id: "s1",
      origin: "ui",
      workspaceId: A,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: START,
      id: "r1",
      inputFileIds: JSON.stringify(inputFileIds),
      inputText: "hi",
      outputFileIds: "[]",
      sessionId: "s1",
      status: "queued",
      workspaceId: A,
    })
    .run();
};

test("a run that lists an attached library file as input downloads it, unchanged by later library edits", async () => {
  await library.write(user(), "notes/a.md", bytes("v1"));
  const record = await links.attach(user(), "notes/a.md");
  insertRunWithInputs([record.id]);
  await library.write(user(), "notes/a.md", bytes("v2 longer"));

  const downloaded = await files.download(runPrincipal, record.id);

  expect(await readBody(downloaded.body)).toBe("v1");
  expect(downloaded.file.source).toBe("library");
});

test("attach copies a library file into a files row a run can list", async () => {
  await library.write(user(), "notes/a.md", bytes("v1"));

  const record = await links.attach(user(), "notes/a.md");

  expect(record).toMatchObject({
    name: "a.md",
    size: 2,
    source: "library",
  });
  const downloaded = await files.download(user(), record.id);
  expect(await readBody(downloaded.body)).toBe("v1");
  expect(await files.describe(user(), [record.id])).toEqual([record]);
});

test("a later library write does not change the attached file", async () => {
  await library.write(user(), "notes/a.md", bytes("v1"));
  const record = await links.attach(user(), "notes/a.md");

  await library.write(user(), "notes/a.md", bytes("v2 longer"));

  const downloaded = await files.download(user(), record.id);
  expect(await readBody(downloaded.body)).toBe("v1");
  const [described] = await files.describe(user(), [record.id]);
  expect(described?.size).toBe(2);
});

test("attach of a missing path is not_found, and of a folder is invalid", async () => {
  await library.write(user(), "notes/a.md", bytes("v1"));

  expect(await errorOf(links.attach(user(), "notes/missing.md"))).toMatchObject(
    { code: "not_found" }
  );
  expect(await errorOf(links.attach(user(), "notes"))).toMatchObject({
    code: "invalid",
  });
  expect(fileRowsIn(A)).toHaveLength(0);
});

test("a user of another workspace cannot attach a path", async () => {
  await library.write(user(A), "docs/secret.md", bytes("a"));

  expect(await errorOf(links.attach(user(B), "docs/secret.md"))).toMatchObject({
    code: "not_found",
  });
  expect(fileRowsIn(B)).toHaveLength(0);
});

test("run and machine principals cannot attach or save", async () => {
  await library.write(user(), "notes/a.md", bytes("v1"));
  const uploaded = await files.upload(user(), {
    body: text("hello"),
    mime: null,
    name: "report.txt",
  });

  const failures = await Promise.all(
    [runPrincipal, machinePrincipal].flatMap((principal) => [
      errorOf(links.attach(principal, "notes/a.md")),
      errorOf(links.save(principal, uploaded.id, "outputs/x.txt")),
    ])
  );
  expect(failures).toHaveLength(4);
  for (const failure of failures) {
    expect(failure).toBeInstanceOf(ForbiddenError);
  }
  expect(libraryWrites(A)).toHaveLength(1);
});

test("save writes an upload into the library, with its folders and one event", async () => {
  const uploaded = await files.upload(user(), {
    body: text("hello"),
    mime: null,
    name: "report.txt",
  });

  const entry = await links.save(user(), uploaded.id, "outputs/bot/report.txt");

  expect(entry).toMatchObject({ path: "outputs/bot/report.txt" });
  expect(
    decode((await library.read(user(), "outputs/bot/report.txt")).bytes)
  ).toBe("hello");
  expect(await library.stat(user(), "outputs")).toMatchObject({ kind: "dir" });
  expect(await library.stat(user(), "outputs/bot")).toMatchObject({
    kind: "dir",
  });
  const writes = libraryWrites(A);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]?.payload ?? "{}")).toMatchObject({
    path: "outputs/bot/report.txt",
  });
});

test("save normalises a leading slash in the path", async () => {
  const uploaded = await files.upload(user(), {
    body: text("hello"),
    mime: null,
    name: "report.txt",
  });

  await links.save(user(), uploaded.id, "/outputs/bot/x.txt");

  expect(decode((await library.read(user(), "outputs/bot/x.txt")).bytes)).toBe(
    "hello"
  );
});

test("save of another workspace's file is not_found and writes nothing", async () => {
  const uploaded = await files.upload(user(A), {
    body: text("hello"),
    mime: null,
    name: "report.txt",
  });

  expect(
    await errorOf(links.save(user(B), uploaded.id, "outputs/x.txt"))
  ).toMatchObject({ code: "not_found" });
  expect(libraryBlobs.objects.size).toBe(0);
  expect(libraryWrites(B)).toHaveLength(0);
  expect(libraryWrites(A)).toHaveLength(0);
});

test("saved copies are independent of each other and of the upload", async () => {
  const uploaded = await files.upload(user(), {
    body: text("hello"),
    mime: null,
    name: "report.txt",
  });

  await links.save(user(), uploaded.id, "outputs/one.txt");
  await links.save(user(), uploaded.id, "outputs/two.txt");
  await library.write(user(), "outputs/one.txt", bytes("changed"));

  expect(decode((await library.read(user(), "outputs/one.txt")).bytes)).toBe(
    "changed"
  );
  expect(decode((await library.read(user(), "outputs/two.txt")).bytes)).toBe(
    "hello"
  );
  const download = await files.download(user(), uploaded.id);
  expect(await readBody(download.body)).toBe("hello");
});
