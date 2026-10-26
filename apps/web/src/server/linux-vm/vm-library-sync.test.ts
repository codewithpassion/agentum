import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { agentLibraryAccess, libraryEntries } from "@repo/db/schema/library";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
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
import { bytesOf, createFakeVm, textOf } from "./fake-vm.ts";
import {
  libraryCopyOf,
  libraryStateOf,
  syncLibraryIn,
  syncLibraryOut,
  vmLocalPort,
  vmManifestStore,
  withLibraryLock,
} from "./vm-library-sync.ts";
import { type LinuxVm, VM_LIBRARY_MANIFEST } from "./vm-port.ts";
import { linuxVmToolsExtension } from "./vm-tools.ts";

const WORKSPACE = "w1";
const AGENT = "a1";
const SESSION = "s1";
const START = "2026-10-16T10:00:00.000Z";
const LIBRARY_VM = "/workspace/library";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

const runAs = (runId: string): Principal => ({
  agentId: AGENT,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
});

let db: ReturnType<typeof migrated>;
let blobs: MemoryLibraryBlobs;
let service: ReturnType<typeof createLibraryService>;

const bytes = (value: string) => bytesOf(value);
const readText = async (path: string) =>
  new TextDecoder().decode((await service.read(user, path)).bytes);

/** The library calls the sync makes, with the principal bound. */
const opsFor = (principal: Principal) => ({
  list: (dir: string) => service.list(principal, dir),
  read: (path: string) => service.read(principal, path),
  remove: (path: string, options?: { recursive?: boolean }) =>
    service.remove(principal, path, options),
  stat: (path: string) => service.stat(principal, path),
  write: (path: string, content: Uint8Array, options?: { ifEtag?: string }) =>
    service.write(principal, path, content, options),
});

const libraryPaths = () =>
  db
    .select()
    .from(libraryEntries)
    .where(eq(libraryEntries.workspaceId, WORKSPACE))
    .orderBy(asc(libraryEntries.path))
    .all()
    .map((row) => row.path);

/** The events of one type, oldest first, with their run id and payload. */
const eventsOf = (type: string) =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, type))
    .orderBy(asc(eventRows.id))
    .all()
    .map((row) => ({
      payload: JSON.parse(row.payload ?? "{}") as unknown,
      runId: row.runId,
    }));

/** A storage object with the run's get and put, kept in a Map. */
const memoryStorage = () => {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      values.set(key, value);
      return Promise.resolve();
    },
    values,
  };
};

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
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: AGENT,
      instructions: "",
      model: "m",
      name: "Ada",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "ada",
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
  for (const runId of ["r1", "r2"]) {
    db.insert(runRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId: AGENT,
        createdAt: START,
        id: runId,
        inputFileIds: "[]",
        inputText: "hi",
        outputFileIds: "[]",
        sessionId: SESSION,
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
  }
});

afterEach(() => {
  mock.restore();
});

test("sync in copies the agent folder and a named library path, and keeps the rest out", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("notes"));
  await service.write(user, "agents/ada/sub/deep.md", bytes("deep"));
  await service.write(user, "shared/brand/logo.md", bytes("logo"));
  await service.write(user, "other/x.md", bytes("x"));
  db.insert(agentLibraryAccess)
    .values({
      agentId: AGENT,
      createdAt: START,
      mode: "read",
      path: "shared/brand",
      workspaceId: WORKSPACE,
    })
    .run();
  const vm = createFakeVm();
  const storage = memoryStorage();

  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: { libraryPaths: ["shared/brand"] },
    slug: "ada",
    storage,
    vm,
  });

  expect(textOf(vm.files.get(`${LIBRARY_VM}/agents/ada/notes.md`))).toBe(
    "notes"
  );
  expect(textOf(vm.files.get(`${LIBRARY_VM}/agents/ada/sub/deep.md`))).toBe(
    "deep"
  );
  expect(textOf(vm.files.get(`${LIBRARY_VM}/shared/brand/logo.md`))).toBe(
    "logo"
  );
  expect(vm.files.has(`${LIBRARY_VM}/other/x.md`)).toBe(false);
  expect(vm.files.has(VM_LIBRARY_MANIFEST)).toBe(true);
  expect(await libraryStateOf(storage)).toEqual({
    conflicts: [],
    ready: true,
    roots: ["agents/ada", "shared/brand"],
  });
});

test("sync in makes the agent folder in the VM even when the library has none", async () => {
  await service.write(user, "shared/brand/logo.md", bytes("logo"));
  const vm = createFakeVm();

  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: { libraryPaths: ["shared/brand"] },
    slug: "ada",
    storage: memoryStorage(),
    vm,
  });

  expect(vm.folders.has(`${LIBRARY_VM}/agents/ada`)).toBe(true);
});

test("the local port makes the parent folders of a new file", async () => {
  const vm = createFakeVm();

  await vmLocalPort(vm).write("agents/ada/new/deep/x.md", bytes("x"));

  expect(vm.folders.has(`${LIBRARY_VM}/agents/ada/new/deep`)).toBe(true);
  expect(textOf(vm.files.get(`${LIBRARY_VM}/agents/ada/new/deep/x.md`))).toBe(
    "x"
  );
});

test("the local port does not list a symlink", async () => {
  const vm = createFakeVm();
  await vm.mkdir(`${LIBRARY_VM}/agents/ada`, { recursive: true });
  await vm.writeFile(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("notes"));
  const withLink: LinuxVm = {
    ...vm,
    list: async (path) => [
      ...(await vm.list(path)),
      { kind: "symlink", name: "link" },
    ],
  };

  expect(await vmLocalPort(withLink).list("agents/ada")).toEqual([
    { kind: "file", name: "notes.md" },
  ]);
});

test("the manifest store ignores bad JSON and keeps only valid entries", async () => {
  const vm = createFakeVm();
  const store = vmManifestStore(vm);

  expect(await store.load()).toEqual([]);
  vm.files.set(VM_LIBRARY_MANIFEST, bytes("{not json"));
  expect(await store.load()).toEqual([]);

  vm.files.set(
    VM_LIBRARY_MANIFEST,
    bytes(
      JSON.stringify([
        { etag: "e1", path: "a.md", sha256: "h1" },
        { etag: "e2", path: 7, sha256: "h2" },
        { path: "b.md", sha256: "h3" },
      ])
    )
  );
  expect(await store.load()).toEqual([
    { etag: "e1", path: "a.md", sha256: "h1" },
  ]);
});

test("sync out sends the agent's edits and new files to the library, once", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("notes"));
  const vm = createFakeVm();
  const storage = memoryStorage();
  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });

  vm.files.set(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("agent edit"));
  await vm.mkdir(`${LIBRARY_VM}/agents/ada/drafts`, { recursive: true });
  await vm.writeFile(`${LIBRARY_VM}/agents/ada/drafts/new.md`, bytes("new"));
  const recordConflict = mock(() => Promise.resolve());
  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict,
    runId: "r1",
    storage,
    vm,
  });
  const writesAfterFirst = eventsOf("library.write").length;

  expect(await readText("agents/ada/notes.md")).toBe("agent edit");
  expect(await readText("agents/ada/drafts/new.md")).toBe("new");
  const runWrites = eventsOf("library.write").filter(
    (event) => event.runId === "r1"
  );
  expect(runWrites.map((event) => event.payload)).toEqual([
    { path: "agents/ada/drafts/new.md", size: 3 },
    { path: "agents/ada/notes.md", size: 10 },
  ]);

  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict,
    runId: "r1",
    storage,
    vm,
  });
  expect(eventsOf("library.write")).toHaveLength(writesAfterFirst);
  expect(recordConflict).not.toHaveBeenCalled();
});

/** Syncs a run in, then has a person and the agent both edit notes.md. */
const editedInBoth = async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  const vm = createFakeVm();
  const storage = memoryStorage();
  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });
  await service.write(user, "agents/ada/notes.md", bytes("person"));
  vm.files.set(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("agent"));
  return { storage, vm };
};

test("a change that lost the race becomes a conflict copy and the library keeps the person's version", async () => {
  const { storage, vm } = await editedInBoth();

  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict: (conflict) => service.recordConflict(runAs("r1"), conflict),
    runId: "r1",
    storage,
    vm,
  });

  expect(await readText("agents/ada/notes.md")).toBe("person");
  expect(await readText("agents/ada/notes.md.conflict-r1")).toBe("agent");
  expect(textOf(vm.files.get(`${LIBRARY_VM}/agents/ada/notes.md`))).toBe(
    "person"
  );
  expect(eventsOf("library.conflict")).toEqual([
    {
      payload: {
        conflictPath: "agents/ada/notes.md.conflict-r1",
        path: "agents/ada/notes.md",
        runId: "r1",
      },
      runId: "r1",
    },
  ]);
});

test("the next run sees the conflict copy, and a second sync out records no new conflict", async () => {
  const { storage, vm } = await editedInBoth();
  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict: (conflict) => service.recordConflict(runAs("r1"), conflict),
    runId: "r1",
    storage,
    vm,
  });

  await syncLibraryIn({
    ops: opsFor(runAs("r2")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });
  expect(await libraryStateOf(storage)).toEqual({
    conflicts: ["agents/ada/notes.md.conflict-r1"],
    ready: true,
    roots: ["agents/ada"],
  });

  const recordConflict = mock(() => Promise.resolve());
  await syncLibraryOut({
    ops: opsFor(runAs("r2")),
    recordConflict,
    runId: "r2",
    storage,
    vm,
  });
  expect(recordConflict).not.toHaveBeenCalled();
  expect(eventsOf("library.conflict")).toHaveLength(1);
});

test("the next run's prompt lists the conflict copy in the VM's library folder", async () => {
  const { storage, vm } = await editedInBoth();
  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict: (conflict) => service.recordConflict(runAs("r1"), conflict),
    runId: "r1",
    storage,
    vm,
  });
  await syncLibraryIn({
    ops: opsFor(runAs("r2")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });

  const [section] =
    linuxVmToolsExtension(() => libraryCopyOf(storage)).sections ?? [];
  const text = await section?.render(undefined as never, BACKGROUND_CONTEXT);

  expect(text).toContain(`${LIBRARY_VM}/agents/ada/notes.md.conflict-r1`);
  expect(text).toContain(`${LIBRARY_VM} holds a synced copy of agents/ada`);
  expect(
    textOf(vm.files.get(`${LIBRARY_VM}/agents/ada/notes.md.conflict-r1`))
  ).toBe("agent");
});

test("sync in leaves an edit that was not synced out alone", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  const vm = createFakeVm();
  const storage = memoryStorage();
  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });
  vm.files.set(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("local edit"));
  await service.write(user, "agents/ada/notes.md", bytes("v2"));

  await syncLibraryIn({
    ops: opsFor(runAs("r2")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });

  expect(textOf(vm.files.get(`${LIBRARY_VM}/agents/ada/notes.md`))).toBe(
    "local edit"
  );
});

test("sync in warns and does not throw when the library fails", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const failing = {
    ...opsFor(runAs("r1")),
    list: () => Promise.reject(new Error("library down")),
  };

  await expect(
    syncLibraryIn({
      ops: failing,
      runtimeConfig: {},
      slug: "ada",
      storage: memoryStorage(),
      vm: createFakeVm(),
    })
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
});

test("the prompt says nothing about a synced copy until a sync in has finished", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  spyOn(console, "warn").mockImplementation(() => undefined);
  const storage = memoryStorage();
  await syncLibraryIn({
    ops: {
      ...opsFor(runAs("r1")),
      list: () => Promise.reject(new Error("down")),
    },
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm: createFakeVm(),
  });

  expect(await libraryCopyOf(storage)).toBeUndefined();
  // The roots are kept, so the end of the run can still send the agent's files.
  expect((await libraryStateOf(storage))?.roots).toEqual(["agents/ada"]);
});

test("sync out warns and does not throw when the library fails", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  const vm = createFakeVm();
  const storage = memoryStorage();
  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });
  vm.files.set(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("agent"));
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const failing = {
    list: () => Promise.reject(new Error("library down")),
    read: () => Promise.reject(new Error("library down")),
    remove: () => Promise.reject(new Error("library down")),
    stat: () => Promise.reject(new Error("library down")),
    write: () => Promise.reject(new Error("library down")),
  };

  await expect(
    syncLibraryOut({
      ops: failing,
      recordConflict: () => Promise.resolve(),
      runId: "r1",
      storage,
      vm,
    })
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
});

test("a conflict that fails to record is warned, and the other conflicts are still recorded", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  await service.write(user, "agents/ada/todo.md", bytes("v1"));
  const vm = createFakeVm();
  const storage = memoryStorage();
  await syncLibraryIn({
    ops: opsFor(runAs("r1")),
    runtimeConfig: {},
    slug: "ada",
    storage,
    vm,
  });
  await service.write(user, "agents/ada/notes.md", bytes("person"));
  await service.write(user, "agents/ada/todo.md", bytes("person"));
  vm.files.set(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("agent"));
  vm.files.set(`${LIBRARY_VM}/agents/ada/todo.md`, bytes("agent"));
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const recorded: string[] = [];
  const recordConflict = mock((conflict: { path: string }) => {
    if (recorded.length === 0) {
      recorded.push(`failed ${conflict.path}`);
      return Promise.reject(new Error("event store down"));
    }
    recorded.push(conflict.path);
    return Promise.resolve();
  });

  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict,
    runId: "r1",
    storage,
    vm,
  });

  expect(recordConflict).toHaveBeenCalledTimes(2);
  expect(recorded).toHaveLength(2);
  expect(warn).toHaveBeenCalled();
  expect(await readText("agents/ada/todo.md.conflict-r1")).toBe("agent");
});

test("sync out without stored sync state does nothing", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  const vm = createFakeVm();
  await vm.mkdir(`${LIBRARY_VM}/agents/ada`, { recursive: true });
  await vm.writeFile(`${LIBRARY_VM}/agents/ada/notes.md`, bytes("agent"));
  const recordConflict = mock(() => Promise.resolve());
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);

  await syncLibraryOut({
    ops: opsFor(runAs("r1")),
    recordConflict,
    runId: "r1",
    storage: memoryStorage(),
    vm,
  });

  expect(recordConflict).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(await readText("agents/ada/notes.md")).toBe("v1");
  expect(libraryPaths()).toEqual([
    "agents",
    "agents/ada",
    "agents/ada/notes.md",
  ]);
});

const instantSleep = () => Promise.resolve();

test("a sync holds the library lock while it runs and releases it after", async () => {
  await service.write(user, "agents/ada/notes.md", bytes("v1"));
  const vm = createFakeVm();
  const during: (string | null)[] = [];
  const ops = opsFor(runAs("r1"));

  await syncLibraryIn({
    ops: {
      ...ops,
      list: (dir: string) => {
        during.push(vm.libraryLockOwner);
        return ops.list(dir);
      },
    },
    runtimeConfig: {},
    slug: "ada",
    storage: memoryStorage(),
    vm,
  });

  expect(during.length).toBeGreaterThan(0);
  expect(during.every((owner) => owner !== null)).toBe(true);
  expect(vm.libraryLockOwner).toBeNull();
});

test("withLibraryLock makes two syncs take turns", async () => {
  const vm = createFakeVm();
  const order: string[] = [];
  const job = (name: string) => () => {
    order.push(`${name} start`);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push(`${name} end`);
        resolve();
      }, 5);
    });
  };
  const sleep = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });

  await Promise.all([
    withLibraryLock(vm, job("a"), { sleep, waitMs: 5000 }),
    withLibraryLock(vm, job("b"), { sleep, waitMs: 5000 }),
  ]);

  expect(order).toEqual(["a start", "a end", "b start", "b end"]);
});

test("withLibraryLock gives up while another sync holds the lock", async () => {
  const vm = createFakeVm();
  await vm.lockLibrary("someone else", 60_000);
  const work = mock(() => Promise.resolve("done"));
  let now = 0;

  await expect(
    withLibraryLock(vm, work, {
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return instantSleep();
      },
      waitMs: 1000,
    })
  ).rejects.toThrow("Another sync holds the library lock");

  expect(work).not.toHaveBeenCalled();
  expect(vm.libraryLockOwner).toBe("someone else");
});

test("withLibraryLock releases only its own hold, and also when the work throws", async () => {
  const vm = createFakeVm();

  await expect(
    withLibraryLock(vm, () => Promise.reject(new Error("boom")))
  ).rejects.toThrow("boom");
  expect(vm.libraryLockOwner).toBeNull();

  // A hold taken over by another owner is not released by the old one.
  await withLibraryLock(vm, async () => {
    await vm.unlockLibrary(vm.libraryLockOwner ?? "");
    await vm.lockLibrary("takeover", 60_000);
  });
  expect(vm.libraryLockOwner).toBe("takeover");
});

test("a failed release is warned and does not fail the sync", async () => {
  const vm = createFakeVm();
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  vm.unlockLibrary = () => Promise.reject(new Error("vm gone"));

  await expect(withLibraryLock(vm, () => Promise.resolve(7))).resolves.toBe(7);
  expect(warn).toHaveBeenCalled();
});

test("withLibraryLock renews its hold while a long sync runs", async () => {
  const vm = createFakeVm();
  const renewals: string[] = [];
  const { lockLibrary } = vm;
  vm.lockLibrary = (owner, ttlMs) => {
    renewals.push(owner);
    return lockLibrary(owner, ttlMs);
  };

  await withLibraryLock(
    vm,
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      }),
    { ttlMs: 15 }
  );

  // One call to take it, at least one more to renew it, all by the same owner.
  expect(renewals.length).toBeGreaterThan(1);
  expect(new Set(renewals).size).toBe(1);
});
