import { beforeEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type {
  ExecutionEnv,
  FileError,
  Result,
} from "@earendil-works/pi-durable/env";
import {
  createEnvConformance,
  createExpectAssertions,
} from "@earendil-works/pi-durable/testing";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { sqliteAtomic } from "@repo/db/atomic";
import { libraryEntries } from "@repo/db/schema/library";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "@repo/services/events";
import { createLibraryService } from "@repo/services/library";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "@repo/services/library/memory";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { asc, eq } from "drizzle-orm";
import type { LibraryOps } from "../library-bash/library-fs.ts";
import { createLibraryEnv } from "./library-env.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

let db: ReturnType<typeof migrated>;
let blobs: MemoryLibraryBlobs;
let service: ReturnType<typeof createLibraryService>;

/** The library service with the principal bound, which is what the app passes in. */
const boundOps = (): LibraryOps => ({
  list: (dir) => service.list(user, dir),
  mkdir: (path) => service.mkdir(user, path),
  move: (from, to) => service.move(user, from, to),
  read: (path) => service.read(user, path),
  remove: (path, options) => service.remove(user, path, options),
  stat: (path) => service.stat(user, path),
  write: (path, content, options) =>
    service.write(user, path, content, options),
});

const libraryPaths = () =>
  db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.workspaceId, WORKSPACE))
    .orderBy(asc(libraryEntries.path))
    .all()
    .map((row) => row.path);

const readText = async (path: string) =>
  decode((await service.read(user, path)).bytes);

/** The error of a call that must fail. */
const failure = (result: Result<unknown, FileError>): FileError => {
  if (result.ok) {
    throw new Error("Expected the call to fail");
  }
  return result.error;
};

/** Tool calls take the environment as `api.env`; the rest of the API is not used here. */
const apiFor = (env: ExecutionEnv) => ({ env }) as unknown as ToolExecutionApi;

// biome-ignore lint/suspicious/noMisplacedAssertion: the conformance cases run inside their tests, where these assertions are called
const assertions = createExpectAssertions(expect);

/**
 * Snapshot readers and listings cannot see an entry removed after the reader
 * opened it, so this case cannot hold: the reader still returns the entries
 * it listed at open.
 */
const SKIPPED = new Set([
  "directory reader skips entries removed during enumeration",
]);

for (const conformance of createEnvConformance({
  assertions,
  symlinks: false,
  withEnv: async (use) => {
    await use(createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE }));
  },
})) {
  const library =
    conformance.name.startsWith("binary reader") ||
    conformance.name.startsWith("directory reader");
  if (library) {
    const register = SKIPPED.has(conformance.name) ? test.skip : test;
    register(conformance.name, () => conformance.run(), conformance.timeoutMs);
  }
}

beforeEach(() => {
  db = migrated();
  blobs = memoryLibraryBlobs();
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  service = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events: eventsService,
  });
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
});

test("the write tool creates the library file, and a relative path lands under /library", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  const result = await createWriteTool().execute(
    { content: "# Notes\n", path: "/library/notes/a.md" },
    apiFor(env),
    BACKGROUND_CONTEXT
  );
  expect(result.output).toEqual([
    { text: "Successfully wrote to /library/notes/a.md", type: "text" },
  ]);
  expect(await readText("notes/a.md")).toBe("# Notes\n");

  await createWriteTool().execute(
    { content: "relative", path: "notes/b.md" },
    apiFor(env),
    BACKGROUND_CONTEXT
  );
  expect(await readText("notes/b.md")).toBe("relative");
});

test("the read tool returns the text of a library file", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  await service.write(user, "notes/a.md", bytes("alpha\nbeta\n"));

  const result = await createReadTool().execute(
    { path: "/library/notes/a.md" },
    apiFor(env),
    BACKGROUND_CONTEXT
  );
  expect(result.output).toEqual([{ text: "alpha\nbeta\n", type: "text" }]);
});

test("the edit tool replaces text in the library, and a missing oldText fails and leaves the file alone", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  await service.write(user, "notes/a.md", bytes("alpha beta\n"));

  await createEditTool().execute(
    {
      edits: [{ newText: "gamma", oldText: "beta" }],
      path: "notes/a.md",
    },
    apiFor(env),
    BACKGROUND_CONTEXT
  );
  expect(await readText("notes/a.md")).toBe("alpha gamma\n");

  await expect(
    createEditTool().execute(
      {
        edits: [{ newText: "delta", oldText: "missing" }],
        path: "/library/notes/a.md",
      },
      apiFor(env),
      BACKGROUND_CONTEXT
    )
  ).rejects.toThrow();
  expect(await readText("notes/a.md")).toBe("alpha gamma\n");
});

test("a path outside /library is refused, and exists answers false for it", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });

  const write = await env.writeFile("/etc/passwd", "x", BACKGROUND_CONTEXT);
  expect(failure(write).code).toBe("permission_denied");
  expect(failure(write).message).toBe(
    "Only paths under /library are available"
  );
  expect(await env.exists("/etc/passwd", BACKGROUND_CONTEXT)).toEqual({
    ok: true,
    value: false,
  });
  expect(libraryPaths()).toEqual([]);
});

test("exec refuses with shell_unavailable", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  const result = await env.exec("ls", undefined, BACKGROUND_CONTEXT);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("shell_unavailable");
  }
});

test("appendFile appends to a file and creates a missing one", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  expect(
    (await env.appendFile("log.txt", "one\n", BACKGROUND_CONTEXT)).ok
  ).toBe(true);
  expect(
    (await env.appendFile("log.txt", "two\n", BACKGROUND_CONTEXT)).ok
  ).toBe(true);
  expect(await readText("log.txt")).toBe("one\ntwo\n");
});

test("a missing file fails with not_found", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  const read = await env.readTextFile(
    "/library/missing.md",
    BACKGROUND_CONTEXT
  );
  expect(failure(read).code).toBe("not_found");
});

test("listDir lists the names and kinds of a folder", async () => {
  const env = createLibraryEnv({ ops: boundOps(), workspaceId: WORKSPACE });
  await service.write(user, "docs/a.md", bytes("a"));
  await service.write(user, "root.txt", bytes("r"));

  const listing = await env.listDir("/library", BACKGROUND_CONTEXT);
  expect(listing.ok).toBe(true);
  if (listing.ok) {
    expect(
      listing.value.map((info) => ({ kind: info.kind, name: info.name }))
    ).toEqual([
      { kind: "directory", name: "docs" },
      { kind: "file", name: "root.txt" },
    ]);
  }
});

test("two workspaces get different environment ids", () => {
  const first = createLibraryEnv({ ops: boundOps(), workspaceId: "w1" });
  const second = createLibraryEnv({ ops: boundOps(), workspaceId: "w2" });
  expect(first.id).not.toBe(second.id);
});
