// Tests for the daemon's library sync: the local port over a real work
// directory, the manifest beside `library/`, the HTTP client against a fake
// Worker, the run token, and the failures a run has to get past.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createMemoryRemote,
  type MemoryRemote,
  textOf,
} from "@repo/library-sync/testing";
import {
  LIBRARY_ETAG_HEADER,
  LIBRARY_IF_ETAG_HEADER,
  type LibraryConflictRequest,
  libraryConflictRequestSchema,
} from "@repo/protocol/library";
import { createMasker } from "@repo/protocol/masker";
import type { CommandRunner } from "./command.ts";
import { createLibraryApi } from "./library-api.ts";
import {
  createDaemonLibrarySync,
  type DaemonLibrarySync,
  type DaemonLibrarySyncOptions,
  fsLibraryWatcher,
  LIBRARY_DIR,
  type LibraryWatcher,
} from "./library-sync.ts";
import { createWorkDisk } from "./work-disk.ts";

const RUN_ID = "run1";
const RUN_TOKEN = "hm_run_token_for_tests_0123456789";
const SERVER = "https://hm.example";
const BASE_PATH = `/api/runs/${RUN_ID}/library`;
const AGENT_PATH = "agents/ada";
const NOTES = "agents/ada/notes.md";
const NESTED = "agents/ada/nested/deep.md";
const NEW_FILE = "agents/ada/new.md";
const LATER_FILE = "agents/ada/later.md";
const CONFLICT_COPY = "agents/ada/notes.md.conflict-run1";
const OUTSIDE = "docs/x.md";
const MANIFEST_NAME = "library.manifest.json";
const OK = 200;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNAUTHORIZED = 401;
const SERVER_ERROR = 500;
const SETTLE_MS = 20;

/** A run that has no sudo side. Single-user disks never reach it. */
const refuseRun: CommandRunner = () =>
  Promise.reject(new Error("single-user disks run no commands"));

const json = (value: unknown, status = OK): Response =>
  Response.json(value, { status });

interface FakeWorker {
  /** The authorization header of every request, in order. */
  authorizations: string[];
  /** The bodies of the conflicts POSTs that were accepted. */
  conflicts: LibraryConflictRequest[];
  /** The start and end of each file PUT, in order. */
  events: string[];
  /** Answers the conflicts POST with a 500 while true. */
  failConflicts: boolean;
  /** Awaited before a PUT is answered, when set. */
  holdPut?: (path: string) => Promise<void>;
  /** Fails every request with a network error while true. */
  offline: boolean;
}

/**
 * A fake of the Worker's library routes on top of a memory remote. It checks
 * the run token on every request and answers the way the routes do.
 */
const fakeWorker = (memory: MemoryRemote) => {
  const state: FakeWorker = {
    authorizations: [],
    conflicts: [],
    events: [],
    failConflicts: false,
    offline: false,
  };

  const file = async (request: Request, path: string): Promise<Response> => {
    if (request.method === "GET") {
      const read = await memory.read(path);
      if (read === null) {
        return json({ error: "not found" }, NOT_FOUND);
      }
      return new Response(read.bytes, {
        headers: { [LIBRARY_ETAG_HEADER]: read.etag },
      });
    }
    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      state.events.push(`put start ${path}`);
      await state.holdPut?.(path);
      const ifEtag = request.headers.get(LIBRARY_IF_ETAG_HEADER);
      const written = await memory.write(
        path,
        bytes,
        ifEtag === null ? undefined : { ifEtag }
      );
      state.events.push(`put end ${path}`);
      return written === null
        ? json({ error: "changed" }, CONFLICT)
        : json(written);
    }
    if (request.method === "DELETE") {
      await memory.delete(path);
      return json({});
    }
    return json({ error: "no such method" }, NOT_FOUND);
  };

  const answer = async (request: Request): Promise<Response> => {
    const authorization = request.headers.get("authorization") ?? "";
    state.authorizations.push(authorization);
    if (authorization !== `Bearer ${RUN_TOKEN}`) {
      return json({ error: "unauthorized" }, UNAUTHORIZED);
    }
    const url = new URL(request.url);
    const route = url.pathname.slice(BASE_PATH.length);
    const path = url.searchParams.get("path") ?? "";
    if (route === "/conflicts" && request.method === "POST") {
      const body = libraryConflictRequestSchema.parse(await request.json());
      if (state.failConflicts) {
        return json({ error: "boom" }, SERVER_ERROR);
      }
      state.conflicts.push(body);
      return json({});
    }
    if (route === "/list" && request.method === "GET") {
      const isRoot = path === "";
      if (!isRoot && (await memory.stat(path)) === null) {
        return json({ error: "not found" }, NOT_FOUND);
      }
      return json({ entries: await memory.list(path) });
    }
    if (route === "/stat" && request.method === "GET") {
      const entry = await memory.stat(path);
      return entry === null
        ? json({ error: "not found" }, NOT_FOUND)
        : json({ entry });
    }
    if (route === "/file") {
      return file(request, path);
    }
    return json({ error: "no such route" }, NOT_FOUND);
  };

  const fetchFn = (
    input: Request | URL | string,
    init?: RequestInit
  ): Promise<Response> => {
    if (state.offline) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    return answer(request);
  };

  return {
    fetch: Object.assign(fetchFn, { preconnect: () => undefined }),
    state,
  };
};

let workDir: string;
let remote: MemoryRemote;
let worker: ReturnType<typeof fakeWorker>;
let lines: string[];

const localPath = (path: string): string => join(workDir, "library", path);
const localText = (path: string): string =>
  readFileSync(localPath(path), "utf8");
const writeLocal = (path: string, text: string): void => {
  mkdirSync(dirname(localPath(path)), { recursive: true });
  writeFileSync(localPath(path), text);
};
const remoteText = (path: string): string | undefined =>
  textOf(remote.files.get(path)?.bytes);

/** A daemon sync over this work directory and the fake Worker. */
const daemonSync = (
  extra: Partial<DaemonLibrarySyncOptions> = {}
): DaemonLibrarySync =>
  createDaemonLibrarySync({
    api: createLibraryApi({
      fetch: worker.fetch,
      masker: createMasker({}),
      runId: RUN_ID,
      runToken: RUN_TOKEN,
      server: SERVER,
    }),
    disk: createWorkDisk({ run: refuseRun, singleUser: true, workDir }),
    log: (message) => {
      lines.push(message);
    },
    roots: [{ mode: "write", path: AGENT_PATH }],
    runId: RUN_ID,
    ...extra,
  });

/** A clock the test advances by hand. Timers fire in order of their due time. */
const manualClock = () => {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    advance: (ms: number) => {
      const end = now + ms;
      while (timers.size > 0) {
        const [due] = [...timers].sort((a, b) => a[1].at - b[1].at);
        if (!due || due[1].at > end) {
          break;
        }
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
    clearTimeout: (handle: number) => {
      timers.delete(handle);
    },
    setTimeout: (fn: () => void, ms: number) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
  };
};

/** A watcher the test drives: `emit` reports a path to the callback the daemon gave it. */
const fakeWatcher = () => {
  const counts = { starts: 0, stops: 0 };
  let onPath: ((libraryPath: string) => void) | undefined;
  const watcher: LibraryWatcher = (callback) => {
    counts.starts += 1;
    onPath = callback;
    return () => {
      counts.stops += 1;
    };
  };
  return {
    counts,
    emit: (libraryPath: string) => {
      onPath?.(libraryPath);
    },
    watcher,
  };
};

/** Lets the sync out that a fired timer started run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** Polls, letting real time pass between checks, until `check` holds or the wait gives up. */
const waitFor = (check: () => boolean, tries = WAIT_TRIES): Promise<void> =>
  check() || tries === 0
    ? Promise.resolve()
    : settle().then(() => waitFor(check, tries - 1));

/** A daemon sync wired to a fake watcher and a clock the test advances. */
const watchedSync = (extra: Partial<DaemonLibrarySyncOptions> = {}) => {
  const watch = fakeWatcher();
  const clock = manualClock();
  const sync = daemonSync({
    clock,
    maxMs: MAX_MS,
    quietMs: QUIET_MS,
    watcher: watch.watcher,
    ...extra,
  });
  return { clock, sync, watch };
};

const QUIET_MS = 100;
const MAX_MS = 1000;
const WAIT_TRIES = 200;
const EDIT_ROUNDS = 10;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "harbourmaster-library-sync-"));
  remote = createMemoryRemote();
  worker = fakeWorker(remote);
  lines = [];
  remote.put(NOTES, "v1 notes");
  remote.put(NESTED, "deep");
  remote.put(OUTSIDE, "not ours");
});

afterEach(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe("sync in", () => {
  test("copies the agent's folder into library, writes the manifest beside it, and leaves other paths alone", async () => {
    expect(await daemonSync().syncIn()).toBe(true);

    expect(localText(NOTES)).toBe("v1 notes");
    expect(localText(NESTED)).toBe("deep");
    expect(existsSync(localPath(OUTSIDE))).toBe(false);

    const manifest = JSON.parse(
      readFileSync(join(workDir, MANIFEST_NAME), "utf8")
    ) as { path: string }[];
    expect(manifest.map((entry) => entry.path)).toEqual([NESTED, NOTES]);
    expect(existsSync(join(workDir, "library", MANIFEST_NAME))).toBe(false);
  });
});

describe("sync out", () => {
  test("sends an edited file and a new file to the library with the run token", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    const etagBefore = remote.files.get(NOTES)?.etag;
    expect(etagBefore).toBeDefined();

    writeLocal(NOTES, "agent notes");
    writeLocal(NEW_FILE, "fresh");
    await sync.syncOut();

    expect(remoteText(NOTES)).toBe("agent notes");
    expect(remote.files.get(NOTES)?.etag).not.toBe(etagBefore);
    expect(remoteText(NEW_FILE)).toBe("fresh");
    expect(worker.state.authorizations.length).toBeGreaterThan(0);
    for (const authorization of worker.state.authorizations) {
      expect(authorization).toBe(`Bearer ${RUN_TOKEN}`);
    }
  });

  test("a local edit that lost the race is kept as a conflict copy beside the file", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    remote.put(NOTES, "person edit");
    writeLocal(NOTES, "agent edit");

    await sync.syncOut();

    expect(remoteText(NOTES)).toBe("person edit");
    expect(remoteText(CONFLICT_COPY)).toBe("agent edit");
    expect(localText(CONFLICT_COPY)).toBe("agent edit");
    expect(localText(NOTES)).toBe("person edit");
    expect(worker.state.conflicts).toEqual([
      { conflictPath: CONFLICT_COPY, path: NOTES },
    ]);
  });

  test("a local delete does not remove a file the library changed since the sync in", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    rmSync(localPath(NOTES));
    remote.put(NOTES, "person edit");

    await sync.syncOut();

    expect(remoteText(NOTES)).toBe("person edit");
    expect(remote.calls).not.toContain(`delete ${NOTES}`);
  });

  test("a local delete of a file the library did not change deletes it in the library", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    rmSync(localPath(NOTES));

    await sync.syncOut();

    expect(remote.files.has(NOTES)).toBe(false);
    expect(remote.calls).toContain(`delete ${NOTES}`);
  });

  test("two calls started together run one after the other", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    writeLocal(NOTES, "agent edit");
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    worker.state.holdPut = async (path) => {
      if (path !== NOTES) {
        return;
      }
      // A file that appears after the first call has listed the folder.
      writeLocal(LATER_FILE, "later");
      started.resolve();
      await gate.promise;
    };

    const first = sync.syncOut();
    const second = sync.syncOut();
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(worker.state.events).toEqual([`put start ${NOTES}`]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(worker.state.events).toEqual([
      `put start ${NOTES}`,
      `put end ${NOTES}`,
      `put start ${LATER_FILE}`,
      `put end ${LATER_FILE}`,
    ]);
    expect(remoteText(LATER_FILE)).toBe("later");
    worker.state.holdPut = undefined;
  });
});

describe("local edits", () => {
  test("an unsent local edit survives a sync in and is reported as kept", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    writeLocal(NOTES, "agent edit");
    remote.put(NOTES, "person edit");

    expect(await sync.syncIn()).toBe(true);

    expect(localText(NOTES)).toBe("agent edit");
    expect(lines.at(-1)).toContain("1 kept for local edits");
  });
});

describe("a run that cannot reach the Worker", () => {
  test("syncIn resolves false and syncOut resolves, each with a warning line", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    writeLocal(NOTES, "agent edit");
    worker.state.offline = true;

    expect(await sync.syncIn()).toBe(false);
    await expect(sync.syncOut()).resolves.toBeUndefined();

    const warnings = lines.filter((line) => line.startsWith("warning:"));
    expect(warnings).toHaveLength(2);
  });

  test("a conflict record the Worker refuses is logged and the sync out still completes", async () => {
    const sync = daemonSync();
    await sync.syncIn();
    remote.put(NOTES, "person edit");
    writeLocal(NOTES, "agent edit");
    worker.state.failConflicts = true;

    await expect(sync.syncOut()).resolves.toBeUndefined();

    expect(remoteText(CONFLICT_COPY)).toBe("agent edit");
    expect(lines).toContain(
      `warning: recording the library conflict for ${NOTES} failed: library conflicts answered HTTP ${SERVER_ERROR}: boom`
    );
  });
});

describe("the manifest", () => {
  test("survives to the next run: nothing is pulled or pushed again", async () => {
    await daemonSync().syncIn();
    remote.calls.splice(0);
    lines.splice(0);

    const next = daemonSync();
    expect(await next.syncIn()).toBe(true);
    expect(remote.calls.filter((call) => call.startsWith("read "))).toEqual([]);
    expect(lines.at(-1)).toContain("0 pulled");

    remote.calls.splice(0);
    await next.syncOut();
    expect(
      remote.calls.filter(
        (call) => call.startsWith("write ") || call.startsWith("delete ")
      )
    ).toEqual([]);
    expect(lines.at(-1)).toContain("0 written, 0 deleted, 0 conflict(s)");
  });
});

describe("pulling a path", () => {
  test("covered keeps the paths that equal a root or sit under one, in any mode", () => {
    const sync = daemonSync({
      roots: [
        { mode: "write", path: AGENT_PATH },
        { mode: "read", path: "docs/guide.md" },
      ],
    });

    expect(
      sync.covered([NOTES, OUTSIDE, "agents/adaX/y.md", "docs/guide.md"])
    ).toEqual([NOTES, "docs/guide.md"]);
  });

  test("pull fetches the covered paths and nothing else", async () => {
    const sync = daemonSync();
    remote.calls.splice(0);

    await sync.pull([NOTES, OUTSIDE]);

    expect(localText(NOTES)).toBe("v1 notes");
    expect(existsSync(localPath(OUTSIDE))).toBe(false);
    expect(remote.calls.some((call) => call.includes(OUTSIDE))).toBe(false);
    expect(lines.at(-1)).toContain("library synced in");
  });

  test("pull with only paths outside every root fetches nothing", async () => {
    const sync = daemonSync();
    remote.calls.splice(0);
    lines.splice(0);

    await sync.pull([OUTSIDE]);

    expect(remote.calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("live sync", () => {
  test("an edit is sent out once the quiet time after it has passed", async () => {
    const { clock, sync, watch } = watchedSync();
    await sync.syncIn();
    expect(sync.startWatching()).toBe(true);

    writeLocal(NOTES, "agent edit");
    watch.emit(NOTES);
    clock.advance(QUIET_MS - 1);
    await settle();
    expect(remoteText(NOTES)).toBe("v1 notes");

    clock.advance(1);
    await settle();
    expect(remoteText(NOTES)).toBe("agent edit");
    sync.stopWatching();
  });

  test("a burst of edits becomes one sync out", async () => {
    const { clock, sync, watch } = watchedSync();
    await sync.syncIn();
    sync.startWatching();

    writeLocal(NOTES, "agent edit");
    watch.emit(NOTES);
    clock.advance(QUIET_MS - 10);
    writeLocal(NEW_FILE, "fresh");
    watch.emit(NOTES);
    watch.emit(NEW_FILE);
    clock.advance(QUIET_MS);
    await settle();

    expect(
      lines.filter((line) => line.startsWith("library synced out"))
    ).toHaveLength(1);
    expect(remote.calls.filter((call) => call.startsWith("write "))).toEqual(
      expect.arrayContaining([`write ${NOTES}`, `write ${NEW_FILE}`])
    );
    expect(
      remote.calls.filter((call) => call.startsWith("write "))
    ).toHaveLength(2);
    sync.stopWatching();
  });

  test("an edit under a read root is refused with a warning while a write root edit is sent", async () => {
    const { clock, sync, watch } = watchedSync({
      roots: [
        { mode: "write", path: NOTES },
        { mode: "read", path: "agents/ada/nested" },
      ],
    });
    await sync.syncIn();
    sync.startWatching();

    writeLocal(NESTED, "local edit");
    writeLocal(NOTES, "agent edit");
    watch.emit(NESTED);
    watch.emit(NOTES);
    clock.advance(QUIET_MS);
    await settle();

    expect(remoteText(NOTES)).toBe("agent edit");
    expect(remoteText(NESTED)).toBe("deep");
    expect(lines).toContain(
      `warning: 1 change(s) under read-only library paths were not sent: ${NESTED}`
    );
    sync.stopWatching();
  });

  test("a report after stopWatching does not sync", async () => {
    const { clock, sync, watch } = watchedSync();
    await sync.syncIn();
    sync.startWatching();
    sync.stopWatching();

    writeLocal(NOTES, "agent edit");
    watch.emit(NOTES);
    clock.advance(MAX_MS * 2);
    await settle();

    expect(remoteText(NOTES)).toBe("v1 notes");
    expect(lines.some((line) => line.startsWith("library synced out"))).toBe(
      false
    );
  });

  test("stopWatching cancels an edit that is waiting to be sent", async () => {
    const { clock, sync, watch } = watchedSync();
    await sync.syncIn();
    expect(sync.startWatching()).toBe(true);
    writeLocal(NOTES, "agent edit");
    watch.emit(NOTES);

    sync.stopWatching();
    clock.advance(MAX_MS * 2);
    await settle();

    expect(remoteText(NOTES)).toBe("v1 notes");
    expect(lines.some((line) => line.startsWith("library synced out"))).toBe(
      false
    );
    expect(watch.counts.stops).toBe(1);
  });

  test("startWatching twice starts one watch", () => {
    const { sync, watch } = watchedSync();

    expect(sync.startWatching()).toBe(true);
    expect(sync.startWatching()).toBe(true);

    expect(watch.counts.starts).toBe(1);
    sync.stopWatching();
  });

  test("startWatching returns false with a warning when the watcher throws", () => {
    const sync = daemonSync({
      watcher: () => {
        throw new Error("no inotify");
      },
    });

    expect(sync.startWatching()).toBe(false);
    expect(lines).toContain(
      "warning: watching the library failed, changes go back at the next checkpoint: no inotify"
    );
  });

  test("startWatching returns false without a watcher", () => {
    expect(daemonSync().startWatching()).toBe(false);
  });
});

describe("fsLibraryWatcher", () => {
  test("reports nested edits with / separators and leaves conflict copies out", async () => {
    const dir = join(workDir, LIBRARY_DIR);
    mkdirSync(join(dir, dirname(NESTED)), { recursive: true });
    const reported: string[] = [];
    const stop = fsLibraryWatcher(dir)((libraryPath) => {
      reported.push(libraryPath);
    });
    try {
      // Bun's recursive watch can drop a write that follows another write
      // soon after, so the edit is written again until it is reported.
      const editUntilReported = (round: number): Promise<void> => {
        writeFileSync(join(dir, NESTED), `edit ${round}`);
        return waitFor(() => reported.includes(NESTED), 10).then(() =>
          reported.includes(NESTED) || round >= EDIT_ROUNDS
            ? undefined
            : editUntilReported(round + 1)
        );
      };
      await editUntilReported(1);
      expect(reported).toContain(NESTED);

      reported.splice(0);
      writeFileSync(join(dir, CONFLICT_COPY), "conflict");
      await waitFor(() => false, 5);
      expect(reported).not.toContain(CONFLICT_COPY);
    } finally {
      stop();
    }
  });

  test("reports files in a folder made after the watch started, including ones written before its watch armed", async () => {
    const dir = join(workDir, LIBRARY_DIR);
    mkdirSync(dir, { recursive: true });
    const reported: string[] = [];
    const stop = fsLibraryWatcher(dir)((libraryPath) => {
      reported.push(libraryPath);
    });
    try {
      mkdirSync(join(dir, "agents/ada/tasks/run1"), { recursive: true });
      writeFileSync(join(dir, "agents/ada/tasks/run1/early.md"), "early");
      await waitFor(() => reported.includes("agents/ada/tasks/run1/early.md"));
      writeFileSync(join(dir, "agents/ada/tasks/run1/late.md"), "late");
      await waitFor(() => reported.includes("agents/ada/tasks/run1/late.md"));

      expect(reported).toContain("agents/ada/tasks/run1/early.md");
      expect(reported).toContain("agents/ada/tasks/run1/late.md");
    } finally {
      stop();
    }
  });

  test("reports nothing after it was stopped", async () => {
    const dir = join(workDir, LIBRARY_DIR);
    mkdirSync(join(dir, "agents/ada"), { recursive: true });
    const reported: string[] = [];
    const stop = fsLibraryWatcher(dir)((libraryPath) => {
      reported.push(libraryPath);
    });
    stop();
    writeFileSync(join(dir, NOTES), "edit");
    await waitFor(() => false, 5);

    expect(reported).toEqual([]);
  });

  test("makes the folder when the library has nothing in it yet", () => {
    const dir = join(workDir, LIBRARY_DIR);
    const stop = fsLibraryWatcher(dir)(() => undefined);
    try {
      expect(existsSync(dir)).toBe(true);
    } finally {
      stop();
    }
  });
});
