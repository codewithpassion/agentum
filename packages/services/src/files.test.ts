import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { files as fileRows } from "@repo/db/schema/files";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { MAX_FILE_BYTES } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { type MemoryFileBlobs, memoryFileBlobs } from "./files/memory.ts";
import { createFilesService } from "./files.ts";
import { systemClock } from "./runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const AGENT = "a1";
const SESSION = "s1";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherUser: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const run = (runId: string, workspaceId = WORKSPACE): Principal => ({
  agentId: AGENT,
  kind: "run",
  runId,
  workspaceId,
});
const machine: Principal = {
  kind: "machine",
  machineId: "m1",
  workspaceId: WORKSPACE,
};
const trigger: Principal = {
  agentId: AGENT,
  kind: "trigger",
  triggerId: "t1",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let blobs: MemoryFileBlobs;
let service: ReturnType<typeof createFilesService>;

const text = (value: string, type = "text/plain") =>
  new Blob([value], { type });

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

/** A file row and its bytes. */
const insertFile = (id: string, workspaceId: string) => {
  const r2Key = `${workspaceId}/files/${id}`;
  db.insert(fileRows)
    .values({
      createdAt: START,
      createdById: "u1",
      createdByKind: "user",
      id,
      mime: "text/plain",
      name: `${id}.txt`,
      r2Key,
      runId: null,
      size: 3,
      source: "upload",
      workspaceId,
    })
    .run();
  blobs.objects.set(r2Key, {
    bytes: new TextEncoder().encode(`(${id})`),
    contentType: "text/plain",
  });
};

const insertRun = (
  id: string,
  { input = [], output = [] }: { input?: string[]; output?: string[] }
) =>
  db
    .insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id,
      inputFileIds: JSON.stringify(input),
      inputText: "hi",
      outputFileIds: JSON.stringify(output),
      sessionId: SESSION,
      status: "done",
      workspaceId: WORKSPACE,
    })
    .run();

const NOT_FOUND = { code: "not_found", message: "File not found" };

/** The error a promise rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

const readBody = (body: ReadableStream<Uint8Array>) =>
  new Response(body).text();

beforeEach(() => {
  db = migrated();
  blobs = memoryFileBlobs();
  service = createFilesService({ blobs, clock: systemClock, db });
  insertWorkspace(WORKSPACE);
  insertWorkspace(OTHER_WORKSPACE);
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: AGENT,
      instructions: "",
      model: "m",
      name: "Agent",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "agent",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: SESSION,
      origin: "ui",
      workspaceId: WORKSPACE,
    })
    .run();
  insertRun("r1", {});
});

test("a user upload stamps the workspace, creator and source, and stores the bytes", async () => {
  const record = await service.upload(user, {
    body: text("abc"),
    mime: "text/plain",
    name: "notes.txt",
  });

  expect(record).toMatchObject({
    mime: "text/plain",
    name: "notes.txt",
    runId: null,
    size: 3,
    source: "upload",
  });
  expect(record).not.toHaveProperty("r2Key");
  const [row] = db
    .select()
    .from(fileRows)
    .where(eq(fileRows.id, record.id))
    .all();
  expect(row).toMatchObject({
    createdById: "u1",
    createdByKind: "user",
    r2Key: `${WORKSPACE}/files/${record.id}`,
    runId: null,
    source: "upload",
    workspaceId: WORKSPACE,
  });
  expect(blobs.objects.get(`${WORKSPACE}/files/${record.id}`)).toEqual({
    bytes: new TextEncoder().encode("abc"),
    contentType: "text/plain",
  });
});

test("a Slack user upload is stamped with source slack", async () => {
  const slackUser: Principal = { ...user, via: "slack" };
  const record = await service.upload(slackUser, {
    body: text("abc"),
    mime: "text/plain",
    name: "from-slack.txt",
  });

  expect(record).toMatchObject({
    runId: null,
    source: "slack",
  });
  const [row] = db
    .select()
    .from(fileRows)
    .where(eq(fileRows.id, record.id))
    .all();
  expect(row).toMatchObject({
    createdById: "u1",
    createdByKind: "user",
    runId: null,
    source: "slack",
    workspaceId: WORKSPACE,
  });
});

test("a run upload stamps the run and the agent as creator", async () => {
  const record = await service.upload(run("r1"), {
    body: text("out"),
    mime: "text/csv",
    name: "result.csv",
  });

  expect(record).toMatchObject({ runId: "r1", source: "run" });
  const [row] = db
    .select()
    .from(fileRows)
    .where(eq(fileRows.id, record.id))
    .all();
  expect(row).toMatchObject({
    createdById: AGENT,
    createdByKind: "agent",
    runId: "r1",
    source: "run",
    workspaceId: WORKSPACE,
  });
});

test("machine, trigger and system principals cannot upload", async () => {
  const errors = await Promise.all(
    [machine, trigger, SYSTEM_PRINCIPAL].map((principal) =>
      errorOf(
        service.upload(principal, { body: text("x"), mime: null, name: "x" })
      )
    )
  );
  expect(errors.every((error) => error instanceof ForbiddenError)).toBe(true);
  expect(blobs.objects.size).toBe(0);
});

test("a file over 50 MB is refused and nothing is stored", async () => {
  const body = new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]);

  const error = await errorOf(
    service.upload(user, { body, mime: null, name: "big.bin" })
  );

  expect(error).toMatchObject({
    code: "invalid",
    message: "Files are limited to 50 MB",
  });
  expect(blobs.objects.size).toBe(0);
  expect(db.select().from(fileRows).all()).toEqual([]);
});

test("an empty file is allowed", async () => {
  const record = await service.upload(user, {
    body: new Blob([]),
    mime: null,
    name: "empty.txt",
  });
  expect(record.size).toBe(0);
});

test("the name keeps the last path segment, drops control characters and caps the length", async () => {
  const upload = (name: string) =>
    service.upload(user, { body: text("x"), mime: null, name });

  expect((await upload("folder/sub\\report.pdf")).name).toBe("report.pdf");
  expect((await upload("\u0000 notes.txt \n")).name).toBe("notes.txt");
  expect((await upload("")).name).toBe("file");
  expect((await upload("dir/")).name).toBe("file");

  const long = await upload(`${"a".repeat(300)}.pdf`);
  expect([...long.name].length).toBe(200);
  expect(long.name.endsWith(".pdf")).toBe(true);
});

test("the mime is lower-cased, loses its parameters and falls back when malformed", async () => {
  const upload = (mime: string | null) =>
    service.upload(user, { body: text("x"), mime, name: "x" });

  expect((await upload("Text/Plain; charset=utf-8")).mime).toBe("text/plain");
  expect((await upload("not a mime")).mime).toBe("application/octet-stream");
  expect((await upload(null)).mime).toBe("application/octet-stream");
});

test("a failed row insert leaves no blob behind", async () => {
  const error = await service
    .upload(run("missing-run"), { body: text("x"), mime: null, name: "x" })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(blobs.objects.size).toBe(0);
  expect(db.select().from(fileRows).all()).toEqual([]);
});

test("a user downloads a file in their workspace", async () => {
  insertFile("f1", WORKSPACE);

  const { body, file } = await service.download(user, "f1");

  expect(file).toMatchObject({ id: "f1", name: "f1.txt", size: 3 });
  expect(file).not.toHaveProperty("r2Key");
  expect(await readBody(body)).toBe("(f1)");
});

test("a user cannot download another workspace's file or an unknown id", async () => {
  insertFile("f-other", OTHER_WORKSPACE);

  expect(await errorOf(service.download(user, "f-other"))).toMatchObject(
    NOT_FOUND
  );
  expect(await errorOf(service.download(otherUser, "f1"))).toMatchObject(
    NOT_FOUND
  );
  expect(await errorOf(service.download(user, "unknown"))).toMatchObject(
    NOT_FOUND
  );
});

test("a file whose blob is missing is not found", async () => {
  insertFile("f1", WORKSPACE);
  await blobs.delete(`${WORKSPACE}/files/f1`);

  expect(await errorOf(service.download(user, "f1"))).toMatchObject(NOT_FOUND);
});

test("a run downloads the files its run lists as input or output", async () => {
  insertFile("in", WORKSPACE);
  insertFile("out", WORKSPACE);
  insertRun("r2", { input: ["in"], output: ["out"] });

  expect(await readBody((await service.download(run("r2"), "in")).body)).toBe(
    "(in)"
  );
  expect(await readBody((await service.download(run("r2"), "out")).body)).toBe(
    "(out)"
  );
});

test("a run cannot download an unlisted file or a listed file from another workspace", async () => {
  insertFile("unlisted", WORKSPACE);
  insertFile("other-ws", OTHER_WORKSPACE);
  insertRun("r2", { input: ["other-ws"] });

  expect(await errorOf(service.download(run("r2"), "unlisted"))).toMatchObject(
    NOT_FOUND
  );
  expect(await errorOf(service.download(run("r2"), "other-ws"))).toMatchObject(
    NOT_FOUND
  );
});

test("machine, trigger and system principals get not found", async () => {
  insertFile("f1", WORKSPACE);
  insertRun("r2", { input: ["f1"] });

  const errors = await Promise.all(
    [machine, trigger, SYSTEM_PRINCIPAL].map((principal) =>
      errorOf(service.download(principal, "f1"))
    )
  );
  expect(errors).toMatchObject([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
});

test("describe returns own-workspace records in input order without r2Key", async () => {
  insertFile("f1", WORKSPACE);
  insertFile("f2", WORKSPACE);
  insertFile("f3", OTHER_WORKSPACE);

  const records = await service.describe(user, ["f2", "missing", "f3", "f1"]);

  expect(records.map((record) => record.id)).toEqual(["f2", "f1"]);
  expect(JSON.stringify(records)).not.toContain("r2Key");
});

test("describe refuses non-user principals and more than 100 ids", async () => {
  await expect(service.describe(run("r1"), [])).rejects.toBeInstanceOf(
    ForbiddenError
  );
  const error = await errorOf(
    service.describe(
      user,
      Array.from({ length: 101 }, (_, i) => `f${i}`)
    )
  );
  expect(error).toMatchObject({ code: "invalid" });
});

test("createdAt comes from the injected clock", async () => {
  const fixed = new Date("2030-01-02T03:04:05.000Z");
  const timed = createFilesService({
    blobs,
    clock: { now: () => fixed, sleep: () => Promise.resolve() },
    db,
  });

  const record = await timed.upload(user, {
    body: text("abc"),
    mime: null,
    name: "a.txt",
  });

  expect(record.createdAt).toBe("2030-01-02T03:04:05.000Z");
});
