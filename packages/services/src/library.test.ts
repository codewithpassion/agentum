import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { agentLibraryAccess, libraryEntries } from "@repo/db/schema/library";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { LIBRARY_FILE_MAX_BYTES, LIBRARY_MAX_BYTES } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { systemClock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const A = "w1";
const B = "w2";
const START = "2026-10-16T10:00:00.000Z";
const AGENT = "a1";
const SESSION = "s1";
const RUN = "r1";

const user = (workspaceId = A, userId = "u1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const runPrincipal: Principal = {
  agentId: AGENT,
  kind: "run",
  runId: RUN,
  workspaceId: A,
};

let notified: {
  byRunId: string | null;
  paths: string[];
  workspaceId: string;
}[];
let db: ReturnType<typeof migrated>;
let blobs: MemoryLibraryBlobs;
let service: ReturnType<typeof createLibraryService>;

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/** The error a promise rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

const rows = (workspaceId = A) =>
  db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.workspaceId, workspaceId))
    .orderBy(asc(libraryEntries.path))
    .all();

const paths = (workspaceId = A) => rows(workspaceId).map((row) => row.path);

const libraryEvents = () =>
  db.select().from(eventRows).orderBy(asc(eventRows.id)).all();

/** Each file holds its own path as content. */
const writeAll = (list: string[]) =>
  Promise.all(list.map((path) => service.write(user(), path, bytes(path))));

// These assertions cover live objects; immutable history is tested in library-versions.test.ts.
const keys = () =>
  [...blobs.objects.keys()]
    .filter((key) => !key.includes("/library-versions/"))
    .sort();

beforeEach(() => {
  notified = [];
  db = migrated();
  blobs = memoryLibraryBlobs();
  const atomic = sqliteAtomic(db);
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  service = createLibraryService({
    atomic,
    blobs,
    clock: systemClock,
    db,
    events: eventsService,
    notify: (change) => {
      notified.push(change);
    },
  });
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
      workspaceId: A,
    })
    .run();
  db.insert(agentLibraryAccess)
    .values(
      ["a", "notes", "skills/a1"].map((path) => ({
        agentId: AGENT,
        createdAt: START,
        mode: "write" as const,
        path,
        workspaceId: A,
      }))
    )
    .run();
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: SESSION,
      origin: "ui",
      workspaceId: A,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: RUN,
      inputFileIds: "[]",
      inputText: "hi",
      outputFileIds: "[]",
      sessionId: SESSION,
      status: "running",
      workspaceId: A,
    })
    .run();
});

test("a write then a list and a read return the file, and the row matches the object", async () => {
  const written = await service.write(
    user(),
    "/notes/today.md",
    bytes("hello")
  );

  const listing = await service.list(user(), "notes");
  expect(listing.map((entry) => entry.path)).toEqual(["notes/today.md"]);
  expect(listing[0]).toMatchObject({
    etag: written.etag,
    kind: "file",
    size: 5,
    updatedBy: { id: "u1", kind: "user" },
  });
  const { bytes: content, entry: read } = await service.read(
    user(),
    "notes/today.md"
  );
  expect(decode(content)).toBe("hello");
  expect(read.etag).toBe(written.etag);

  const object = blobs.objects.get("w1/library/notes/today.md");
  expect(object?.bytes.byteLength).toBe(5);
  expect(rows().find((row) => row.path === "notes/today.md")?.size).toBe(
    object?.bytes.byteLength as number
  );
  // The folder was made on the way, and the root lists it.
  expect(
    (await service.list(user(), "/")).map((e) => [e.path, e.kind])
  ).toEqual([["notes", "dir"]]);
  expect(await service.stat(user(), "notes")).toMatchObject({ kind: "dir" });
});

test("stat, list and walks read the index, not the blob store", async () => {
  await service.write(user(), "a/b.md", bytes("x"));
  blobs.touched.length = 0;
  await service.stat(user(), "a/b.md");
  await service.list(user(), "a");
  await service.list(user(), "");
  expect(blobs.touched).toEqual([]);
});

test("overwriting a file changes its etag and size, not the row count", async () => {
  const first = await service.write(user(), "f.md", bytes("one"));
  const second = await service.write(user(), "f.md", bytes("three"));
  expect(second.etag).not.toBe(first.etag);
  expect(paths()).toEqual(["f.md"]);
  expect((await service.stat(user(), "f.md")).size).toBe(5);
});

test("paths with .. past the root or control characters are refused and no key outside the workspace prefix is touched", async () => {
  await service.write(user(B), "secret.md", bytes("b"));
  blobs.touched.length = 0;
  const bad = [
    "../x",
    "..",
    "a/../../w2/library/secret.md",
    "/../w2/library/secret.md",
    "a\u0000b",
    "a\nb",
    "a".repeat(513),
    new Array(21).fill("a").join("/"),
  ];
  const failures = await Promise.all(
    bad.flatMap((path) => [
      errorOf(service.write(user(), path, bytes("x"))),
      errorOf(service.read(user(), path)),
      errorOf(service.stat(user(), path)),
      errorOf(service.list(user(), path)),
      errorOf(service.mkdir(user(), path)),
      errorOf(service.remove(user(), path, { recursive: true })),
      errorOf(service.move(user(), "ok.md", path)),
      errorOf(service.move(user(), path, "ok.md")),
    ])
  );
  expect(failures).toHaveLength(bad.length * 8);
  for (const failure of failures) {
    expect(failure).toMatchObject({ code: "invalid" });
  }
  // Allowed, normalised writes too.
  await service.write(user(), "a/../b//c.md", bytes("x"));
  await service.write(user(), "/./d.md", bytes("x"));
  expect(paths()).toEqual(["b", "b/c.md", "d.md"]);
  expect(blobs.touched.length).toBeGreaterThan(0);
  for (const key of blobs.touched) {
    expect(
      key.startsWith("w1/library/") || key.startsWith("w1/library-versions/")
    ).toBe(true);
  }
  expect(blobs.objects.get("w2/library/secret.md")?.bytes).toEqual(bytes("b"));
});

test("a user of one workspace gets not_found for another workspace's paths", async () => {
  await service.write(user(B), "docs/secret.md", bytes("b"));
  const notFound = { code: "not_found" };

  expect(await errorOf(service.read(user(A), "docs/secret.md"))).toMatchObject(
    notFound
  );
  expect(await errorOf(service.stat(user(A), "docs/secret.md"))).toMatchObject(
    notFound
  );
  expect(await errorOf(service.list(user(A), "docs"))).toMatchObject(notFound);
  expect(
    await errorOf(service.remove(user(A), "docs/secret.md"))
  ).toMatchObject(notFound);
  expect(
    await errorOf(service.move(user(A), "docs/secret.md", "mine.md"))
  ).toMatchObject(notFound);
  expect(await service.list(user(A), "")).toEqual([]);

  // The same path in A is a different file.
  await service.write(user(A), "docs/secret.md", bytes("a"));
  expect(decode((await service.read(user(B), "docs/secret.md")).bytes)).toBe(
    "b"
  );
  expect(decode((await service.read(user(A), "docs/secret.md")).bytes)).toBe(
    "a"
  );
});

test("machines, triggers and the system principal have no library access", async () => {
  const others: Principal[] = [
    { kind: "machine", machineId: "m1", workspaceId: A },
    { agentId: AGENT, kind: "trigger", triggerId: "t1", workspaceId: A },
    { kind: "system" },
  ];
  const failures = await Promise.all(
    others.flatMap((principal) => [
      errorOf(service.list(principal, "")),
      errorOf(service.write(principal, "x.md", bytes("x"))),
    ])
  );
  for (const failure of failures) {
    expect(failure).toMatchObject({ code: "forbidden" });
  }
});

test("a read-only API key reads but does not write", async () => {
  await service.write(user(), "x.md", bytes("x"));
  const reader: Principal = {
    apiKey: { access: "read", id: "k1" },
    kind: "user",
    userId: "u1",
    via: "api_key",
    workspaceId: A,
  };
  expect(decode((await service.read(reader, "x.md")).bytes)).toBe("x");
  const failures = await Promise.all([
    errorOf(service.write(reader, "y.md", bytes("y"))),
    errorOf(service.mkdir(reader, "d")),
    errorOf(service.remove(reader, "x.md")),
    errorOf(service.move(reader, "x.md", "z.md")),
  ]);
  for (const failure of failures) {
    expect(failure).toMatchObject({ code: "forbidden" });
  }
  expect(paths()).toEqual(["x.md"]);
});

test("two writes with the same stale ifEtag give one success and one conflict", async () => {
  const first = await service.write(user(), "race.md", bytes("v1"));

  const results = await Promise.all([
    errorOf(
      service.write(user(), "race.md", bytes("left"), {
        ifEtag: first.etag ?? "",
      })
    ),
    errorOf(
      service.write(user(), "race.md", bytes("right"), {
        ifEtag: first.etag ?? "",
      })
    ),
  ]);

  expect(results.filter((result) => result === null)).toHaveLength(1);
  expect(results.filter((result) => result !== null)).toEqual([
    expect.objectContaining({ code: "conflict" }),
  ]);
  // The index follows the winner.
  const winner = decode((await service.read(user(), "race.md")).bytes);
  expect(["left", "right"]).toContain(winner);
  expect((await service.stat(user(), "race.md")).etag).toBe(
    blobs.objects.get("w1/library/race.md")?.etag as string
  );
  // The loser changed nothing, and the old etag stays stale.
  expect(
    await errorOf(
      service.write(user(), "race.md", bytes("late"), {
        ifEtag: first.etag ?? "",
      })
    )
  ).toMatchObject({ code: "conflict" });
  expect(decode((await service.read(user(), "race.md")).bytes)).toBe(winner);
});

test("ifEtag with the current etag writes, and with no file it conflicts", async () => {
  const first = await service.write(user(), "f.md", bytes("v1"));
  const second = await service.write(user(), "f.md", bytes("v2"), {
    ifEtag: first.etag ?? "",
  });
  expect(second.etag).not.toBe(first.etag);
  expect(
    await errorOf(
      service.write(user(), "missing.md", bytes("x"), { ifEtag: "etag-1" })
    )
  ).toMatchObject({ code: "conflict" });
  expect(paths()).toEqual(["f.md"]);
});

test("a recursive remove deletes every row and object under the folder and nothing else", async () => {
  await writeAll([
    "docs/a.md",
    "docs/deep/b.md",
    "docs/deep/er/c.md",
    "docs0/keep.md",
    "docs-x/keep.md",
    "docsx.md",
    "top.md",
  ]);
  await service.mkdir(user(), "docs/empty");
  await service.write(user(B), "docs/other.md", bytes("b"));

  await service.remove(user(), "docs", { recursive: true });

  expect(paths()).toEqual([
    "docs-x",
    "docs-x/keep.md",
    "docs0",
    "docs0/keep.md",
    "docsx.md",
    "top.md",
  ]);
  expect(keys()).toEqual([
    "w1/library/docs-x/keep.md",
    "w1/library/docs0/keep.md",
    "w1/library/docsx.md",
    "w1/library/top.md",
    "w2/library/docs/other.md",
  ]);
  expect(paths(B)).toEqual(["docs", "docs/other.md"]);
});

test("removing a non-empty folder needs recursive, a file or empty folder does not", async () => {
  await service.write(user(), "d/f.md", bytes("x"));
  expect(await errorOf(service.remove(user(), "d"))).toMatchObject({
    code: "conflict",
  });
  expect(paths()).toEqual(["d", "d/f.md"]);
  await service.remove(user(), "d/f.md");
  await service.remove(user(), "d");
  expect(paths()).toEqual([]);
  expect(keys()).toEqual([]);
  expect(await errorOf(service.remove(user(), "d"))).toMatchObject({
    code: "not_found",
  });
  expect(await errorOf(service.remove(user(), ""))).toMatchObject({
    code: "invalid",
  });
});

test("each write and delete adds one event with the right actor", async () => {
  await service.write(user(A, "u7"), "a/one.md", bytes("12345"));
  await service.write(runPrincipal, "a/two.md", bytes("123"));
  expect(notified.at(-1)).toEqual({
    byRunId: RUN,
    paths: ["a/two.md"],
    workspaceId: A,
  });
  await service.mkdir(user(), "empty");
  await service.remove(user(A, "u7"), "a/one.md");
  await service.remove(runPrincipal, "a", { recursive: true });
  // Refused calls add nothing.
  await errorOf(service.write(user(), "../x", bytes("x")));
  await errorOf(service.remove(user(), "nope"));

  const log = libraryEvents().map((event) => ({
    actorId: event.actorId,
    actorKind: event.actorKind,
    agentId: event.agentId,
    payload: JSON.parse(event.payload ?? "{}"),
    runId: event.runId,
    type: event.type,
    workspaceId: event.workspaceId,
  }));
  expect(log).toEqual([
    {
      actorId: "u7",
      actorKind: "user",
      agentId: null,
      payload: { path: "a/one.md", size: 5 },
      runId: null,
      type: "library.write",
      workspaceId: A,
    },
    {
      actorId: AGENT,
      actorKind: "agent",
      agentId: AGENT,
      payload: { path: "a/two.md", size: 3 },
      runId: RUN,
      type: "library.write",
      workspaceId: A,
    },
    {
      actorId: "u7",
      actorKind: "user",
      agentId: null,
      payload: { path: "a/one.md", size: 5 },
      runId: null,
      type: "library.delete",
      workspaceId: A,
    },
    {
      actorId: AGENT,
      actorKind: "agent",
      agentId: AGENT,
      payload: { path: "a", size: 3 },
      runId: RUN,
      type: "library.delete",
      workspaceId: A,
    },
  ]);
});

test("a conflicting write adds no event and no row", async () => {
  const first = await service.write(user(), "f.md", bytes("v1"));
  await service.write(user(), "f.md", bytes("v2"));
  const before = libraryEvents().length;
  await errorOf(
    service.write(user(), "f.md", bytes("v3"), { ifEtag: first.etag ?? "" })
  );
  expect(libraryEvents()).toHaveLength(before);
  expect(decode((await service.read(user(), "f.md")).bytes)).toBe("v2");
});

test("mkdir makes the folder and its parents, and is idempotent", async () => {
  const made = await service.mkdir(user(), "a/b/c");
  expect(made).toMatchObject({ kind: "dir", path: "a/b/c", size: 0 });
  expect(paths()).toEqual(["a", "a/b", "a/b/c"]);
  await service.mkdir(user(), "a/b");
  expect(paths()).toEqual(["a", "a/b", "a/b/c"]);
  expect((await service.list(user(), "a")).map((e) => e.path)).toEqual(["a/b"]);
  expect(libraryEvents()).toHaveLength(0);
});

test("a file in the way of a folder or a path is refused", async () => {
  await service.write(user(), "f", bytes("x"));
  expect(
    await errorOf(service.write(user(), "f/g.md", bytes("x")))
  ).toMatchObject({ code: "invalid" });
  expect(await errorOf(service.mkdir(user(), "f"))).toMatchObject({
    code: "invalid",
  });
  expect(await errorOf(service.mkdir(user(), "f/h"))).toMatchObject({
    code: "invalid",
  });
  await service.mkdir(user(), "d");
  expect(await errorOf(service.write(user(), "d", bytes("x")))).toMatchObject({
    code: "invalid",
  });
  expect(await errorOf(service.read(user(), "d"))).toMatchObject({
    code: "invalid",
  });
  expect(await errorOf(service.list(user(), "f"))).toMatchObject({
    code: "not_found",
  });
  expect(paths()).toEqual(["d", "f"]);
});

test("move renames a file, replaces a file, and keeps the bytes", async () => {
  await service.write(user(), "a/old.md", bytes("old"));
  const moved = await service.move(user(), "a/old.md", "b/new.md");
  expect(moved).toMatchObject({ kind: "file", path: "b/new.md", size: 3 });
  expect(paths()).toEqual(["a", "b", "b/new.md"]);
  expect(keys()).toEqual(["w1/library/b/new.md"]);
  expect(decode((await service.read(user(), "b/new.md")).bytes)).toBe("old");

  await service.write(user(), "other.md", bytes("other"));
  await service.move(user(), "other.md", "b/new.md");
  expect(paths()).toEqual(["a", "b", "b/new.md"]);
  expect(decode((await service.read(user(), "b/new.md")).bytes)).toBe("other");
  expect(keys()).toEqual(["w1/library/b/new.md"]);
});

test("move renames a folder with everything under it", async () => {
  await writeAll(["src/a.md", "src/sub/b.md", "src0/keep.md"]);
  await service.mkdir(user(), "src/empty");

  const moved = await service.move(user(), "src", "dst/lib");

  expect(moved).toMatchObject({ kind: "dir", path: "dst/lib" });
  expect(paths()).toEqual([
    "dst",
    "dst/lib",
    "dst/lib/a.md",
    "dst/lib/empty",
    "dst/lib/sub",
    "dst/lib/sub/b.md",
    "src0",
    "src0/keep.md",
  ]);
  expect(keys()).toEqual([
    "w1/library/dst/lib/a.md",
    "w1/library/dst/lib/sub/b.md",
    "w1/library/src0/keep.md",
  ]);
  expect(decode((await service.read(user(), "dst/lib/sub/b.md")).bytes)).toBe(
    "src/sub/b.md"
  );
  expect(
    rows().every(
      (row) => row.parent === row.path.split("/").slice(0, -1).join("/")
    )
  ).toBe(true);
});

test("move refuses a missing source, an existing folder, and a move into itself", async () => {
  await service.write(user(), "f.md", bytes("x"));
  await service.write(user(), "d/g.md", bytes("x"));
  expect(await errorOf(service.move(user(), "nope", "x"))).toMatchObject({
    code: "not_found",
  });
  expect(await errorOf(service.move(user(), "f.md", "d"))).toMatchObject({
    code: "conflict",
  });
  expect(await errorOf(service.move(user(), "d", "f.md"))).toMatchObject({
    code: "conflict",
  });
  expect(await errorOf(service.move(user(), "d", "d/e"))).toMatchObject({
    code: "invalid",
  });
  expect(await errorOf(service.move(user(), "f.md", "f.md"))).toMatchObject({
    code: "invalid",
  });
  expect(await errorOf(service.move(user(), "f.md", "f.md/x"))).toMatchObject({
    code: "invalid",
  });
  expect(paths()).toEqual(["d", "d/g.md", "f.md"]);
});

test("a file over 10 MB is refused, and one of exactly 10 MB is kept", async () => {
  expect(
    await errorOf(
      service.write(user(), "big", new Uint8Array(LIBRARY_FILE_MAX_BYTES + 1))
    )
  ).toMatchObject({ code: "invalid" });
  expect(paths()).toEqual([]);
  expect(keys()).toEqual([]);
  await service.write(user(), "big", new Uint8Array(LIBRARY_FILE_MAX_BYTES));
  expect((await service.stat(user(), "big")).size).toBe(LIBRARY_FILE_MAX_BYTES);
});

test("the library is capped at 1 GB per workspace, and an overwrite counts only the difference", async () => {
  db.insert(libraryEntries)
    .values({
      etag: "e",
      kind: "file",
      mtime: START,
      parent: "",
      path: "huge.bin",
      size: LIBRARY_MAX_BYTES - 10,
      updatedById: "u1",
      updatedByKind: "user",
      workspaceId: A,
    })
    .run();

  await service.write(user(), "ten.bin", new Uint8Array(10));
  expect(
    await errorOf(service.write(user(), "one-more.bin", new Uint8Array(1)))
  ).toMatchObject({ code: "invalid" });
  // Overwriting the 10-byte file with 10 bytes still fits.
  await service.write(user(), "ten.bin", new Uint8Array(10));
  // Another workspace has its own budget.
  await service.write(user(B), "x.bin", new Uint8Array(1));
});

const skillText = (name: string, description: string, body = "# Body") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test("a valid SKILL.md saves for a user and for a run", async () => {
  const text = skillText("shout", "Shouts things.");
  const saved = await service.write(
    user(),
    "skills/u1/shout/SKILL.md",
    bytes(text)
  );
  expect(saved).toMatchObject({
    kind: "file",
    path: "skills/u1/shout/SKILL.md",
  });
  const ran = await service.write(
    runPrincipal,
    "skills/a1/shout/SKILL.md",
    bytes(text)
  );
  expect(ran).toMatchObject({ kind: "file", path: "skills/a1/shout/SKILL.md" });
  expect(
    decode((await service.read(user(), "skills/u1/shout/SKILL.md")).bytes)
  ).toBe(text);
});

test("a SKILL.md under skills/ saves like any other file, even with broken frontmatter", async () => {
  const text = "# shout\n\nNo frontmatter here.\n";
  const saved = await service.write(
    user(),
    "skills/u1/shout/SKILL.md",
    bytes(text)
  );
  expect(saved).toMatchObject({
    kind: "file",
    path: "skills/u1/shout/SKILL.md",
  });
  expect(
    decode((await service.read(user(), "skills/u1/shout/SKILL.md")).bytes)
  ).toBe(text);
});

test("a file under skills/ that is not a SKILL.md at that depth is not checked", async () => {
  const notes = bytes("no frontmatter, and any text at all");
  await service.write(user(), "skills/u1/shout/notes.md", notes);
  await service.write(user(), "skills/u1/shout/extra/SKILL.md", notes);
  await service.write(user(), "skills/u1/SKILL.md", notes);
  expect(
    decode((await service.read(user(), "skills/u1/shout/notes.md")).bytes)
  ).toBe("no frontmatter, and any text at all");
  expect(paths()).toEqual([
    "skills",
    "skills/u1",
    "skills/u1/SKILL.md",
    "skills/u1/shout",
    "skills/u1/shout/extra",
    "skills/u1/shout/extra/SKILL.md",
    "skills/u1/shout/notes.md",
  ]);
});

test("an edit of an existing skill with ifEtag saves when it is valid", async () => {
  const first = await service.write(
    user(),
    "skills/u1/shout/SKILL.md",
    bytes(skillText("shout", "Shouts."))
  );
  const second = await service.write(
    user(),
    "skills/u1/shout/SKILL.md",
    bytes(skillText("shout", "Shouts louder.")),
    { ifEtag: first.etag ?? "" }
  );
  expect(second.etag).not.toBe(first.etag);
  expect(
    decode((await service.read(user(), "skills/u1/shout/SKILL.md")).bytes)
  ).toContain("Shouts louder.");
});

test("a move of a whole valid skill folder to another owner works", async () => {
  await service.write(
    user(),
    "skills/u1/shout/SKILL.md",
    bytes(skillText("shout", "Shouts."))
  );
  await service.write(user(), "skills/u1/shout/extra.txt", bytes("more"));

  const moved = await service.move(
    user(),
    "skills/u1/shout",
    "skills/u2/shout"
  );

  expect(moved).toMatchObject({ kind: "dir", path: "skills/u2/shout" });
  expect(paths()).toEqual([
    "skills",
    "skills/u1",
    "skills/u2",
    "skills/u2/shout",
    "skills/u2/shout/SKILL.md",
    "skills/u2/shout/extra.txt",
  ]);
  expect(keys()).toEqual([
    "w1/library/skills/u2/shout/SKILL.md",
    "w1/library/skills/u2/shout/extra.txt",
  ]);
});

test("recordCommand logs one library.command event with the actor, and refuses a machine", async () => {
  await service.recordCommand(user(A, "u7"), {
    exitCode: 0,
    script: "ls",
    storageCalls: 3,
    wallMs: 12,
  });
  await service.recordCommand(runPrincipal, {
    exitCode: 1,
    script: "cat nope",
    storageCalls: 1,
    wallMs: 2,
  });
  const log = libraryEvents().map((event) => ({
    actorId: event.actorId,
    actorKind: event.actorKind,
    agentId: event.agentId,
    payload: JSON.parse(event.payload ?? "null"),
    runId: event.runId,
    type: event.type,
  }));
  expect(log).toEqual([
    {
      actorId: "u7",
      actorKind: "user",
      agentId: null,
      payload: { exitCode: 0, script: "ls", storageCalls: 3, wallMs: 12 },
      runId: null,
      type: "library.command",
    },
    {
      actorId: AGENT,
      actorKind: "agent",
      agentId: AGENT,
      payload: { exitCode: 1, script: "cat nope", storageCalls: 1, wallMs: 2 },
      runId: RUN,
      type: "library.command",
    },
  ]);
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    workspaceId: A,
  };
  expect(
    await errorOf(
      service.recordCommand(machine, {
        exitCode: 0,
        script: "ls",
        storageCalls: 0,
        wallMs: 0,
      })
    )
  ).toBeInstanceOf(ForbiddenError);
});

test("recordCommand strips secrets from the script", async () => {
  await service.recordCommand(user(), {
    exitCode: 0,
    script: "curl https://bob:hunter2@example.com/x",
    storageCalls: 0,
    wallMs: 1,
  });
  const [event] = libraryEvents();
  expect(event?.payload).not.toContain("hunter2");
});

test("recordScript logs one script.run event with the actor, and refuses a machine", async () => {
  await service.recordScript(user(A, "u7"), {
    durationMs: 42,
    exitCode: 0,
    script: "notes/build.ts",
    stderrBytes: 0,
    stdoutBytes: 10,
  });
  await service.recordScript(runPrincipal, {
    durationMs: 7,
    exitCode: 1,
    script: "inline",
    stderrBytes: 5,
    stdoutBytes: 0,
  });
  const log = libraryEvents().map((event) => ({
    actorId: event.actorId,
    actorKind: event.actorKind,
    agentId: event.agentId,
    payload: JSON.parse(event.payload ?? "null"),
    runId: event.runId,
    type: event.type,
  }));
  expect(log).toEqual([
    {
      actorId: "u7",
      actorKind: "user",
      agentId: null,
      payload: {
        durationMs: 42,
        exitCode: 0,
        script: "notes/build.ts",
        stderrBytes: 0,
        stdoutBytes: 10,
        text: "Ran notes/build.ts, exit code 0, 42 ms",
      },
      runId: null,
      type: "script.run",
    },
    {
      actorId: AGENT,
      actorKind: "agent",
      agentId: AGENT,
      payload: {
        durationMs: 7,
        exitCode: 1,
        script: "inline",
        stderrBytes: 5,
        stdoutBytes: 0,
        text: "Ran inline, exit code 1, 7 ms",
      },
      runId: RUN,
      type: "script.run",
    },
  ]);
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    workspaceId: A,
  };
  expect(
    await errorOf(
      service.recordScript(machine, {
        durationMs: 0,
        exitCode: 0,
        script: "inline",
        stderrBytes: 0,
        stdoutBytes: 0,
      })
    )
  ).toBeInstanceOf(ForbiddenError);
});

test("recordScript keeps the code, args and output out of the event", async () => {
  await service.recordScript(user(), {
    args: ["SECRET"],
    code: "SECRET",
    durationMs: 3,
    exitCode: 0,
    output: "SECRET",
    script: "inline",
    stderrBytes: 0,
    stdoutBytes: 0,
  } as never);
  const [event] = libraryEvents();
  expect(Object.keys(JSON.parse(event?.payload ?? "null")).sort()).toEqual([
    "durationMs",
    "exitCode",
    "script",
    "stderrBytes",
    "stdoutBytes",
    "text",
  ]);
  expect(event?.payload).not.toContain("SECRET");
});

test("recordConflict logs a run's conflict with its run id in the payload", async () => {
  await service.recordConflict(runPrincipal, {
    conflictPath: "/notes/a (conflict).md",
    path: "/notes/a.md",
  });
  const log = libraryEvents().map((event) => ({
    actorId: event.actorId,
    actorKind: event.actorKind,
    agentId: event.agentId,
    payload: JSON.parse(event.payload ?? "null"),
    runId: event.runId,
    type: event.type,
  }));
  expect(log).toEqual([
    {
      actorId: AGENT,
      actorKind: "agent",
      agentId: AGENT,
      payload: {
        conflictPath: "notes/a (conflict).md",
        path: "notes/a.md",
        runId: RUN,
      },
      runId: RUN,
      type: "library.conflict",
    },
  ]);
});

test("recordConflict logs a user's conflict with no runId key in the payload", async () => {
  await service.recordConflict(user(A, "u7"), {
    conflictPath: "notes/a (conflict).md",
    path: "notes/a.md",
  });
  const [event] = libraryEvents();
  expect(event).toMatchObject({
    actorId: "u7",
    actorKind: "user",
    agentId: null,
    runId: null,
    type: "library.conflict",
  });
  expect(JSON.parse(event?.payload ?? "null")).toEqual({
    conflictPath: "notes/a (conflict).md",
    path: "notes/a.md",
  });
});

test("recordConflict refuses a machine", async () => {
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    workspaceId: A,
  };
  expect(
    await errorOf(
      service.recordConflict(machine, {
        conflictPath: "a (conflict).md",
        path: "a.md",
      })
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(libraryEvents()).toEqual([]);
});

test("pendingConflicts returns the conflict copies under a root, sorted", async () => {
  await writeAll([
    "notes/b.md.conflict-r1",
    "notes/a.md.conflict-r2",
    "notes/deep/c.md.conflict-r3",
  ]);
  expect(await service.pendingConflicts(user(), ["notes"])).toEqual([
    "notes/a.md.conflict-r2",
    "notes/b.md.conflict-r1",
    "notes/deep/c.md.conflict-r3",
  ]);
});

test("pendingConflicts leaves out a copy outside the roots", async () => {
  await writeAll(["notes/a.md.conflict-r1", "other/b.md.conflict-r1"]);
  expect(await service.pendingConflicts(user(), ["notes"])).toEqual([
    "notes/a.md.conflict-r1",
  ]);
});

test("pendingConflicts leaves out plain files and names that only contain conflict", async () => {
  await writeAll([
    "notes/a.md",
    "notes/conflict.md",
    "notes/conflicted.md",
    "notes/a.conflict.md",
  ]);
  expect(await service.pendingConflicts(user(), [""])).toEqual([]);
});

test("pendingConflicts leaves out a folder named like a copy and what is inside it", async () => {
  await service.write(user(), "x.conflict-1/inside.md", bytes("x"));
  expect(paths()).toContain("x.conflict-1");
  expect(await service.pendingConflicts(user(), [""])).toEqual([]);
});

test("pendingConflicts returns a copy at the root path itself", async () => {
  await writeAll(["notes/a.md.conflict-r1"]);
  expect(
    await service.pendingConflicts(user(), ["notes/a.md.conflict-r1"])
  ).toEqual(["notes/a.md.conflict-r1"]);
});

test("pendingConflicts never returns copies of another workspace", async () => {
  await service.write(user(B), "notes/a.md.conflict-r1", bytes("b"));
  expect(await service.pendingConflicts(user(A), [""])).toEqual([]);
});

test("pendingConflicts answers a user and a run, and refuses a machine", async () => {
  await writeAll(["notes/a.md.conflict-r1"]);
  const machine: Principal = {
    kind: "machine",
    machineId: "m1",
    workspaceId: A,
  };
  expect(await service.pendingConflicts(user(), ["notes"])).toEqual([
    "notes/a.md.conflict-r1",
  ]);
  expect(await service.pendingConflicts(runPrincipal, ["notes"])).toEqual([
    "notes/a.md.conflict-r1",
  ]);
  expect(
    await errorOf(service.pendingConflicts(machine, ["notes"]))
  ).toBeInstanceOf(ForbiddenError);
});

test("pendingConflicts returns [] for an empty root list", async () => {
  await writeAll(["notes/a.md.conflict-r1"]);
  expect(await service.pendingConflicts(user(), [])).toEqual([]);
});
