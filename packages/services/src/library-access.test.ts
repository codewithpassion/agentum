import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { libraryEntries } from "@repo/db/schema/library";
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

test("runs use home, wiki and grants; denied paths and history are hidden", async () => {
  const { createLibraryAccessService } = await import("./library/access.ts");
  const access = createLibraryAccessService({ db, atomic: sqliteAtomic(db), clock: systemClock, events: createEventsService({ db, blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() } }) });
  await access.setGrant(user(), AGENT, "/shared/read/", "read");
  await access.setGrant(user(), AGENT, "shared/write", "write");
  for (const path of ["agents/agent/a", "wiki/a", "shared/read/a", "shared/write/a", "private/a"]) {
    await service.write(user(), path, bytes(path));
  }
  for (const path of ["agents/agent/a", "wiki/a", "shared/read/a", "shared/write/a"]) {
    expect((await service.read(runPrincipal, path)).entry.path).toBe(path);
    expect((await service.stat(runPrincipal, path)).path).toBe(path);
    expect(await service.versions(runPrincipal, path)).toHaveLength(1);
  }
  await service.write(runPrincipal, "agents/agent/new", bytes("home"));
  await service.write(runPrincipal, "shared/write/new", bytes("grant"));
  for (const path of ["wiki/a", "shared/read/a", "private/a", "agents/agent-two/a"]) {
    await expect(service.write(runPrincipal, path, bytes("no"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.remove(runPrincipal, path, { recursive: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.mkdir(runPrincipal, path)).rejects.toBeInstanceOf(ForbiddenError);
  }
  await expect(service.read(runPrincipal, "private/a")).rejects.toMatchObject({ code: "not_found" });
  await expect(service.stat(runPrincipal, "private")).rejects.toMatchObject({ code: "not_found" });
  await expect(service.versions(runPrincipal, "private/a")).rejects.toMatchObject({ code: "not_found" });
  await expect(service.list(runPrincipal, "private")).rejects.toMatchObject({ code: "not_found" });
  const [version] = await service.versions(user(), "private/a");
  await expect(service.readVersion(runPrincipal, version!.id)).rejects.toMatchObject({ code: "not_found" });
  expect((await service.list(runPrincipal, "")).map(row => row.path)).not.toContain("private");
  expect((await service.list(runPrincipal, "shared")).map(row => row.path)).toEqual(["shared/read", "shared/write"]);
  await expect(service.move(runPrincipal, "shared/read/a", "agents/agent/a")).rejects.toBeInstanceOf(ForbiddenError);
  await expect(access.setGrant(runPrincipal, AGENT, "private", "write")).rejects.toBeInstanceOf(ForbiddenError);
  await expect(access.listGrants(user(B), AGENT)).rejects.toMatchObject({ code: "not_found" });
  await expect(access.setGrant(user(), AGENT, "/", "write")).rejects.toMatchObject({ code: "invalid" });
  await access.removeGrant(user(), AGENT, "shared/read");
  expect(await access.listGrants(user(), AGENT)).toMatchObject([{ path: "shared/write", mode: "write" }]);
  expect(libraryEvents().filter(event => event.type === "library.access")).toHaveLength(4);
});

test("read-only people cannot mutate files or grants", async () => {
  const { createLibraryAccessService } = await import("./library/access.ts");
  const access = createLibraryAccessService({ db, atomic: sqliteAtomic(db), clock: systemClock, events: createEventsService({ db, blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() } }) });
  const reader: Principal = { kind: "user", workspaceId: A, userId: "u1", via: "api_key", apiKey: { id: "key", access: "read" } };
  await service.write(user(), "private/a", bytes("ok"));
  expect((await service.read(reader, "private/a")).entry.path).toBe("private/a");
  await expect(service.write(reader, "private/a", bytes("no"))).rejects.toBeInstanceOf(ForbiddenError);
  await expect(access.setGrant(reader, AGENT, "private", "write")).rejects.toBeInstanceOf(ForbiddenError);
  await expect(access.removeGrant(reader, AGENT, "private")).rejects.toBeInstanceOf(ForbiddenError);
});
