import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { libraryVersions } from "@repo/db/schema/library";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import { composeWith } from "../compose.ts";
import { tickJobs } from "./jobs.ts";
import { runTick, type TickDeps, type TickJob } from "./registry.ts";

const NOW = new Date("2026-10-16T09:30:00.000Z");

let db: ReturnType<typeof migrated>;
let deps: TickDeps;

beforeEach(() => {
  db = migrated();
  const clock: Clock = { now: () => NOW, sleep: () => Promise.resolve() };
  const blobs = new Map<string, string>();
  const { services } = composeWith({
    allowedOrgIds: [],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(blobs.get(key) ?? null),
        put: (key, body) => {
          blobs.set(key, body);
          return Promise.resolve();
        },
      },
      clock,
      devFakeRuntime: false,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  deps = { clock, services };
});

const counting = (name: string, calls: string[]): TickJob => ({
  name,
  run: () => {
    calls.push(name);
    return Promise.resolve();
  },
});

test("runs each registered job once and stamps the report with the injected clock", async () => {
  const calls: string[] = [];
  const report = await runTick(
    [counting("a", calls), counting("b", calls), counting("c", calls)],
    deps
  );

  expect(calls.toSorted()).toEqual(["a", "b", "c"]);
  expect(report.at).toBe(NOW.toISOString());
  expect(report.jobs).toEqual([
    { name: "a", ok: true },
    { name: "b", ok: true },
    { name: "c", ok: true },
  ]);
});

test("a job that throws is reported and the others still run", async () => {
  const calls: string[] = [];
  const failing: TickJob = {
    name: "boom",
    run: () => Promise.reject(new Error("no luck")),
  };

  const report = await runTick(
    [counting("before", calls), failing, counting("after", calls)],
    deps
  );

  expect(calls.toSorted()).toEqual(["after", "before"]);
  expect(report.jobs.find((job) => job.name === "boom")).toEqual({
    error: "no luck",
    name: "boom",
    ok: false,
  });
});

test("two jobs with one name are refused before any runs", async () => {
  const calls: string[] = [];

  await expect(
    runTick([counting("same", calls), counting("same", calls)], deps)
  ).rejects.toThrow("Two tick jobs are named same");
  expect(calls).toEqual([]);
});

test("the sweep and the reaper are registered", () => {
  expect(tickJobs.map((job) => job.name)).toEqual(
    expect.arrayContaining(["runs.sweep", "runs.reap"])
  );
});

test("the request expiry job is registered once", () => {
  const names = tickJobs.map((job) => job.name);
  expect(names.filter((name) => name === "requests.expire")).toHaveLength(1);
  expect(new Set(names).size).toBe(names.length);
});

test("the routine jobs are registered", () => {
  expect(tickJobs.map((job) => job.name)).toEqual(
    expect.arrayContaining(["routines.fire", "routines.settle"])
  );
});

test("the library version prune is registered", () => {
  expect(tickJobs.map((job) => job.name)).toContain("library.prune-versions");
});

test("the library version prune drops an expired deleted file's history", async () => {
  db.insert(workspaces)
    .values({
      clerkOrgId: "org1",
      createdAt: NOW.toISOString(),
      id: "w1",
      name: "test",
      timezone: "UTC",
    })
    .run();
  const principal = {
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: "w1",
  } as const;
  await deps.services.library.write(
    principal,
    "notes.txt",
    new TextEncoder().encode("old")
  );
  await deps.services.library.remove(principal, "notes.txt");
  expect(db.select().from(libraryVersions).all()).toHaveLength(2);

  const job = tickJobs.find((item) => item.name === "library.prune-versions");
  const later = new Date(NOW.getTime() + 31 * 86_400_000);
  const report = await runTick(job ? [job] : [], {
    ...deps,
    clock: { ...deps.clock, now: () => later },
  });

  expect(report.jobs).toEqual([{ name: "library.prune-versions", ok: true }]);
  expect(db.select().from(libraryVersions).all()).toEqual([]);
});

test("the registered jobs append nothing to events when none has work", async () => {
  const report = await runTick(tickJobs, deps);

  expect(report.jobs.every((job) => job.ok)).toBe(true);
  expect(db.select().from(events).all()).toEqual([]);
});
