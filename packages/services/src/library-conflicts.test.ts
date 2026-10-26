import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { libraryConflicts } from "@repo/db/schema/library";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "./events.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { systemClock } from "./runs/types.ts";

const user = { kind: "user", userId: "u", via: "session", workspaceId: "w" } as const;
const run = { agentId: "a", kind: "run", runId: "r", workspaceId: "w" } as const;
const path = "notes/a";
const conflictPath = `${path}.conflict-r`;
const bytes = (s: string) => new TextEncoder().encode(s);
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createLibraryService>;
let fail: boolean;
const row = () => db.select().from(libraryConflicts).all()[0];
const id = () => {
  const value = row()?.id;
  if (!value) { throw new Error("Missing conflict"); }
  return value;
};
beforeEach(async () => {
  db = migrated();
  fail = false;
  const createdAt = new Date().toISOString();
  await db.insert(workspaces).values({ clerkOrgId: "o", createdAt, id: "w", name: "W", timezone: "UTC" });
  await db.insert(agents).values({ createdAt, createdBy: "u", id: "a", instructions: "", model: "m", name: "Agent", runtime: "fake", runtimeConfig: "{}", slug: "agent", status: "active", workspaceId: "w" });
  await db.insert(sessions).values({ actorId: "u", actorKind: "user", agentId: "a", createdAt, id: "s", origin: "ui", workspaceId: "w" });
  await db.insert(runs).values({ actorId: "u", actorKind: "user", agentId: "a", createdAt, id: "r", inputText: "", sessionId: "s", status: "running", workspaceId: "w" });
  const atomic = sqliteAtomic(db);
  service = createLibraryService({ atomic: (statements) => fail ? Promise.reject(new Error("batch failed")) : atomic(statements), blobs: memoryLibraryBlobs(), clock: systemClock, db, events: createEventsService({ blobs: { get: async () => null, put: async () => undefined }, db }) });
  await service.write(user, path, bytes("library"));
  await service.write(user, conflictPath, bytes("agent"));
});
const record = () => service.recordConflict(run, { conflictPath, path });

test("record opens a scoped row with its event; a failed batch records neither", async () => {
  fail = true;
  await expect(record()).rejects.toThrow("batch failed");
  expect(row()).toBeUndefined();
  expect(db.select().from(eventRows).all().filter((e) => e.type === "library.conflict")).toHaveLength(0);
  fail = false;
  await record();
  expect(row()).toMatchObject({ agentId: "a", conflictPath, path, runId: "r", status: "open", workspaceId: "w" });
  expect(await service.listConflicts(user)).toHaveLength(1);
  expect(await service.listConflicts({ ...user, workspaceId: "other" })).toEqual([]);
});

for (const choice of ["keep-library", "keep-agent"] as const) {
  test(`${choice} preserves the chosen bytes and history and closes once`, async () => {
    await record();
    await service.resolveConflict(user, id(), choice);
    expect((await service.read(user, path)).bytes).toEqual(bytes(choice === "keep-agent" ? "agent" : "library"));
    expect(await service.versions(user, path)).toHaveLength(choice === "keep-agent" ? 2 : 1);
    await expect(service.read(user, conflictPath)).rejects.toMatchObject({ code: "not_found" });
    expect(row()).toMatchObject({ resolution: choice, status: "resolved" });
    expect(row()?.resolvedAt).toBeTruthy();
    expect(await service.listConflicts(user)).toEqual([]);
    expect(db.select().from(eventRows).all().filter((e) => e.type === "library.conflict.resolved")).toHaveLength(1);
    await expect(service.resolveConflict(user, id(), choice)).rejects.toMatchObject({ code: "conflict" });
  });
}

for (const operation of ["remove", "move", "recursive-remove", "folder-move"] as const) {
  test(`${operation} closes copies with the file change, including rollback`, async () => {
    await record();
    const change = () => {
      if (operation === "remove") { return service.remove(user, conflictPath); }
      if (operation === "move") { return service.move(user, conflictPath, "saved"); }
      if (operation === "recursive-remove") { return service.remove(user, "notes", { recursive: true }); }
      return service.move(user, "notes", "saved");
    };
    fail = true;
    await expect(change()).rejects.toThrow("batch failed");
    expect(row()?.status).toBe("open");
    fail = false;
    await change();
    expect(row()?.status).toBe("resolved");
  });
}

test("resolution requires a writing person and an open row in their workspace", async () => {
  await record();
  await expect(service.resolveConflict(run, id(), "keep-agent")).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.resolveConflict({ ...user, apiKey: { access: "read", id: "key" } }, id(), "keep-agent")).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.resolveConflict({ ...user, workspaceId: "other" }, id(), "keep-agent")).rejects.toMatchObject({ code: "not_found" });
  expect(row()?.status).toBe("open");
});
