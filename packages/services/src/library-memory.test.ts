import { beforeEach, expect, test } from "bun:test";
import { type Atomic, sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import {
  agentLibraryAccess,
  libraryEntries,
  libraryVersions,
} from "@repo/db/schema/library";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "./library/memory.ts";
import type { VersionRow } from "./library/versions.ts";
import { createLibraryService } from "./library.ts";
import { systemClock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const A = "w1";
const START = "2026-10-16T10:00:00.000Z";
const AGENT = "a1";
const SESSION = "s1";
const RUN = "r1";
const RUN_FOR_A = "r2";
const RUN_FOR_B = "r3";
const MEMORY = "agents/scout/memory";
const PEOPLE = `${MEMORY}/people.md`;
const INDEX = `${MEMORY}/index.md`;
const PRIVATE_A = `${MEMORY}/private/user_a.md`;
const BLOB_INDEX = `${A}/library/${INDEX}`;

const user = (userId: string): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId: A,
});
const runAs = (runId: string): Principal => ({
  agentId: AGENT,
  kind: "run",
  runId,
  workspaceId: A,
});

let db: ReturnType<typeof migrated>;
let blobs: MemoryLibraryBlobs;
let notified: {
  byRunId: string | null;
  paths: string[];
  workspaceId: string;
}[];
let service: ReturnType<typeof createLibraryService>;

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/** The error a promise rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

const contentOf = async (principal: Principal, path: string) =>
  decode((await service.read(principal, path)).bytes);

const entryPaths = () =>
  db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.workspaceId, A))
    .orderBy(asc(libraryEntries.path))
    .all()
    .map((row) => row.path);

const versionsOf = (path: string) =>
  db.select().from(libraryVersions).where(eq(libraryVersions.path, path)).all();

/** A service over the same database with its own blobs and commit, for failure cases. */
const serviceWith = (
  store: MemoryLibraryBlobs,
  commit: Atomic = sqliteAtomic(db)
) =>
  createLibraryService({
    atomic: commit,
    blobs: store,
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      db,
    }),
    notify: (change) => {
      notified.push(change);
    },
  });

/** Stores blobs as the default store does, except that a put to `key` fails. */
const failingPut = (key: string): MemoryLibraryBlobs => ({
  ...blobs,
  put: (target, content, options) =>
    target === key
      ? Promise.reject(new Error("store down"))
      : blobs.put(target, content, options),
});

beforeEach(() => {
  notified = [];
  db = migrated();
  blobs = memoryLibraryBlobs();
  service = serviceWith(blobs);
  for (const id of [A, "w2"]) {
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
      createdBy: "user_a",
      id: AGENT,
      instructions: "",
      model: "m",
      name: "Scout",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "scout",
      status: "active",
      workspaceId: A,
    })
    .run();
  db.insert(agentLibraryAccess)
    .values({
      agentId: AGENT,
      createdAt: START,
      mode: "write",
      path: "agents/scout",
      workspaceId: A,
    })
    .run();
  db.insert(sessionRows)
    .values({
      actorId: "user_a",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: SESSION,
      origin: "ui",
      workspaceId: A,
    })
    .run();
  const runFixtures = [
    { id: RUN, onBehalfOfUserId: null },
    { id: RUN_FOR_A, onBehalfOfUserId: "user_a" },
    { id: RUN_FOR_B, onBehalfOfUserId: "user_b" },
  ];
  for (const fixture of runFixtures) {
    db.insert(runRows)
      .values({
        actorId: "user_a",
        actorKind: "user",
        agentId: AGENT,
        createdAt: START,
        id: fixture.id,
        inputFileIds: "[]",
        inputText: "hi",
        onBehalfOfUserId: fixture.onBehalfOfUserId,
        outputFileIds: "[]",
        sessionId: SESSION,
        status: "running",
        workspaceId: A,
      })
      .run();
  }
});

test("a run cannot write, remove or move a memory file, and cannot make a memory folder", async () => {
  await service.write(user("user_a"), PEOPLE, bytes("people"));
  await service.write(runAs(RUN), "agents/scout/notes.md", bytes("notes"));

  expect(
    await errorOf(service.write(runAs(RUN), PEOPLE, bytes("from run")))
  ).toBeInstanceOf(ForbiddenError);
  expect(await errorOf(service.remove(runAs(RUN), PEOPLE))).toBeInstanceOf(
    ForbiddenError
  );
  expect(
    await errorOf(
      service.move(runAs(RUN), PEOPLE, "agents/scout/notes/people.md")
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(service.move(runAs(RUN), "agents/scout/notes.md", PEOPLE))
  ).toBeInstanceOf(ForbiddenError);
  expect(
    await errorOf(service.mkdir(runAs(RUN), `${MEMORY}/archive`))
  ).toBeInstanceOf(ForbiddenError);

  expect(await contentOf(user("user_a"), PEOPLE)).toBe("people");
  expect(await contentOf(user("user_a"), "agents/scout/notes.md")).toBe(
    "notes"
  );
});

test("a run cannot remove a folder that holds a memory file", async () => {
  await service.write(user("user_a"), PEOPLE, bytes("people"));

  expect(
    await errorOf(
      service.remove(runAs(RUN), "agents/scout", { recursive: true })
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(await contentOf(user("user_a"), PEOPLE)).toBe("people");
});

test("a user writes and reads a memory file by hand", async () => {
  await service.write(user("user_a"), PEOPLE, bytes("by hand"));

  expect(await contentOf(user("user_b"), PEOPLE)).toBe("by hand");
  expect(
    (await service.list(user("user_b"), MEMORY)).map((entry) => entry.path)
  ).toEqual([PEOPLE]);
});

test("another person cannot see, list, stat, version or write a private memory file", async () => {
  await service.writeMemoryFiles(
    user("user_a"),
    [{ bytes: bytes("a notes"), path: PRIVATE_A }],
    () => []
  );

  expect(await errorOf(service.read(user("user_b"), PRIVATE_A))).toMatchObject({
    code: "not_found",
  });
  expect(await errorOf(service.stat(user("user_b"), PRIVATE_A))).toMatchObject({
    code: "not_found",
  });
  expect(
    await errorOf(service.versions(user("user_b"), PRIVATE_A))
  ).toMatchObject({ code: "not_found" });
  expect(
    (await service.list(user("user_b"), `${MEMORY}/private`)).map(
      (entry) => entry.path
    )
  ).toEqual([]);
  expect(
    (await service.list(user("user_b"), MEMORY)).map((entry) => entry.path)
  ).toEqual([`${MEMORY}/private`]);
  expect(
    await errorOf(service.write(user("user_b"), PRIVATE_A, bytes("mine now")))
  ).toBeInstanceOf(ForbiddenError);

  expect(await contentOf(user("user_a"), PRIVATE_A)).toBe("a notes");
});

test("a run reads the private memory file of the person it runs for and no one else's", async () => {
  await service.writeMemoryFiles(
    user("user_a"),
    [{ bytes: bytes("a notes"), path: PRIVATE_A }],
    () => []
  );

  expect(await contentOf(runAs(RUN_FOR_A), PRIVATE_A)).toBe("a notes");
  expect(
    (await service.list(runAs(RUN_FOR_A), `${MEMORY}/private`)).map(
      (entry) => entry.path
    )
  ).toEqual([PRIVATE_A]);
  expect(
    await errorOf(service.read(runAs(RUN_FOR_B), PRIVATE_A))
  ).toMatchObject({ code: "not_found" });
  expect(await errorOf(service.read(runAs(RUN), PRIVATE_A))).toMatchObject({
    code: "not_found",
  });
});

test("a user moves a folder that holds only their own private memory file", async () => {
  await service.writeMemoryFiles(
    user("user_a"),
    [{ bytes: bytes("a notes"), path: PRIVATE_A }],
    () => []
  );

  expect(
    await errorOf(service.move(user("user_b"), MEMORY, "elsewhere"))
  ).toBeInstanceOf(ForbiddenError);
  await service.move(user("user_a"), MEMORY, "elsewhere");

  expect(await contentOf(user("user_a"), "elsewhere/private/user_a.md")).toBe(
    "a notes"
  );
});

test("writeMemoryFiles writes two memory files for a run in one call and returns their versions in order", async () => {
  let seen: VersionRow[] = [];
  const versions = await service.writeMemoryFiles(
    runAs(RUN),
    [
      { bytes: bytes("people"), path: PEOPLE },
      { bytes: bytes("index"), path: INDEX },
    ],
    (rows) => {
      seen = rows;
      return [];
    }
  );

  expect(versions.map((version) => version.path)).toEqual([PEOPLE, INDEX]);
  expect(versions.map((version) => version.version)).toEqual([1, 1]);
  expect(seen).toEqual(versions);
  expect(versions[0]?.runId).toBe(RUN);
  expect(await contentOf(user("user_a"), PEOPLE)).toBe("people");
  expect(await contentOf(user("user_a"), INDEX)).toBe("index");
  expect(notified).toEqual([
    { byRunId: RUN, paths: [PEOPLE, INDEX], workspaceId: A },
  ]);
});

test("writeMemoryFiles refuses a run writing another agent's memory folder", async () => {
  expect(
    await errorOf(
      service.writeMemoryFiles(
        runAs(RUN),
        [{ bytes: bytes("x"), path: "agents/other/memory/people.md" }],
        () => []
      )
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(entryPaths()).not.toContain("agents/other/memory/people.md");
});

test("writeMemoryFiles refuses a path outside memory and the memory folder itself", async () => {
  expect(
    await errorOf(
      service.writeMemoryFiles(
        runAs(RUN),
        [{ bytes: bytes("x"), path: "agents/scout/notes.md" }],
        () => []
      )
    )
  ).toMatchObject({ code: "invalid" });
  expect(
    await errorOf(
      service.writeMemoryFiles(
        runAs(RUN),
        [{ bytes: bytes("x"), path: MEMORY }],
        () => []
      )
    )
  ).toMatchObject({ code: "invalid" });
  expect(entryPaths()).toEqual([]);
});

test("writeMemoryFiles refuses another person's private memory file as forbidden", async () => {
  expect(
    await errorOf(
      service.writeMemoryFiles(
        runAs(RUN_FOR_B),
        [{ bytes: bytes("x"), path: PRIVATE_A }],
        () => []
      )
    )
  ).toBeInstanceOf(ForbiddenError);
  expect(entryPaths()).toEqual([]);
});

test("a stale etag conflicts and leaves both memory files unchanged", async () => {
  await service.write(user("user_a"), PEOPLE, bytes("people"));
  await service.write(user("user_a"), INDEX, bytes("index"));
  const before = await service.read(user("user_a"), PEOPLE);

  expect(
    await errorOf(
      service.writeMemoryFiles(
        runAs(RUN),
        [
          { bytes: bytes("new people"), path: PEOPLE },
          { bytes: bytes("new index"), ifEtag: "etag-stale", path: INDEX },
        ],
        () => []
      )
    )
  ).toMatchObject({ code: "conflict" });

  expect(await contentOf(user("user_a"), PEOPLE)).toBe("people");
  expect(await contentOf(user("user_a"), INDEX)).toBe("index");
  expect((await service.read(user("user_a"), PEOPLE)).entry.etag).toBe(
    before.entry.etag
  );
  expect(versionsOf(PEOPLE)).toHaveLength(1);
});

test("a failed second put rolls the first memory file back to its old bytes", async () => {
  await service.write(user("user_a"), PEOPLE, bytes("people"));
  await service.write(user("user_a"), INDEX, bytes("index"));
  const failing = serviceWith(failingPut(BLOB_INDEX));
  let statementsRan = false;

  expect(
    await errorOf(
      failing.writeMemoryFiles(
        runAs(RUN),
        [
          { bytes: bytes("new people"), path: PEOPLE },
          { bytes: bytes("new index"), path: INDEX },
        ],
        () => {
          statementsRan = true;
          return [];
        }
      )
    )
  ).toMatchObject({ message: "store down" });

  expect(await contentOf(user("user_a"), PEOPLE)).toBe("people");
  expect(await contentOf(user("user_a"), INDEX)).toBe("index");
  expect(versionsOf(PEOPLE)).toHaveLength(1);
  expect(versionsOf(INDEX)).toHaveLength(1);
  expect(statementsRan).toBe(false);
});

test("a failed commit rolls every memory file back and removes the new ones", async () => {
  await service.write(user("user_a"), PEOPLE, bytes("people"));
  const failingCommit: Atomic = () =>
    Promise.reject(new Error("commit failed"));
  const failing = serviceWith(blobs, failingCommit);

  expect(
    await errorOf(
      failing.writeMemoryFiles(
        runAs(RUN),
        [
          { bytes: bytes("new people"), path: PEOPLE },
          { bytes: bytes("new index"), path: INDEX },
        ],
        () => []
      )
    )
  ).toMatchObject({ message: "commit failed" });

  expect(await contentOf(user("user_a"), PEOPLE)).toBe("people");
  expect(blobs.objects.has(BLOB_INDEX)).toBe(false);
  expect(entryPaths()).not.toContain(INDEX);
  expect(versionsOf(PEOPLE)).toHaveLength(1);
});

test("a routine run and a run for another person see no private memory file", async () => {
  await service.writeMemoryFiles(
    user("user_a"),
    [{ bytes: bytes("a notes"), path: PRIVATE_A }],
    () => []
  );
  const [version] = await service.versions(user("user_a"), PRIVATE_A);
  expect(version).toBeDefined();
  const versionId = version?.id ?? "";

  const expectHidden = async (principal: Principal) => {
    expect(await service.list(principal, `${MEMORY}/private`)).toEqual([]);
    expect(await errorOf(service.stat(principal, PRIVATE_A))).toMatchObject({
      code: "not_found",
    });
    expect(await errorOf(service.versions(principal, PRIVATE_A))).toMatchObject(
      { code: "not_found" }
    );
    expect(
      await errorOf(service.readVersion(principal, versionId))
    ).toMatchObject({ code: "not_found" });
    expect(
      (await service.list(principal, MEMORY)).map((entry) => entry.path)
    ).toEqual([`${MEMORY}/private`]);
  };

  await expectHidden(runAs(RUN));
  await expectHidden(runAs(RUN_FOR_B));
});

test("a run for the person reads their private file's history", async () => {
  await service.writeMemoryFiles(
    user("user_a"),
    [{ bytes: bytes("a notes"), path: PRIVATE_A }],
    () => []
  );
  const history = await service.versions(runAs(RUN_FOR_A), PRIVATE_A);
  const [latest] = history;

  expect(history.length).toBeGreaterThanOrEqual(1);
  expect(latest).toBeDefined();
  expect(
    decode(
      (await service.readVersion(runAs(RUN_FOR_A), latest?.id ?? "")).bytes
    )
  ).toBe("a notes");
  expect((await service.stat(runAs(RUN_FOR_A), PRIVATE_A)).path).toBe(
    PRIVATE_A
  );
});

test("a run for another person cannot list a private file through the agent home", async () => {
  await service.writeMemoryFiles(
    user("user_a"),
    [{ bytes: bytes("a notes"), path: PRIVATE_A }],
    () => []
  );

  expect(
    (await service.list(runAs(RUN_FOR_B), "agents/scout")).map(
      (entry) => entry.path
    )
  ).not.toContain(PRIVATE_A);
  expect(
    await errorOf(service.read(runAs(RUN_FOR_B), PRIVATE_A))
  ).toMatchObject({
    code: "not_found",
  });
});
