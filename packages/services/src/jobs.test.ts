import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { slackApps } from "@repo/db/schema/slack";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import type { JobSentence } from "@repo/db/shared";

import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import { createJobsService } from "./jobs.ts";
import { createRunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const JOB_LINE_MAX_CHARS = 140;
const NOW = "2026-11-20T00:00:00.000Z";
const NEXT = "2026-11-20T00:05:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
};
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createJobsService>;

beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values(
      ["w1", "w2"].map((id) => ({
        clerkOrgId: id,
        createdAt: NOW,
        id,
        name: id,
        timezone: "UTC",
      }))
    )
    .run();
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: NOW,
      credentialHash: "h",
      enrolledBy: "u1",
      id: "m1",
      name: "Machine",
      singleUser: false,
      status: "online",
      workspaceId: "w1",
    })
    .run();
  db.insert(agents)
    .values(
      ["a1", "a2"].map((id) => ({
        askLevel: "outside" as const,
        createdAt: NOW,
        createdBy: "u1",
        emailLocal: id,
        id,
        instructions: "",
        machineId: "m1",
        model: "m",
        name: id === "a1" ? "Alpha" : "Beta",
        runtime: "machine" as const,
        runtimeConfig: "{}",
        slug: id,
        soul: "\n  Keep the harbour tidy\nMore detail",
        status: "active",
        workspaceId: "w1",
      }))
    )
    .run();
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };
  const events = createEventsService({ blobs, db });
  const runs = createRunsService({
    adapters: [
      {
        cancel: () => Promise.resolve(),
        dispatch: () => Promise.resolve(),
        kind: "machine",
      },
    ],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  service = createJobsService({
    clock,
    db,
    events,
    mailDomain: "mail.example",
    runs,
  });
});
afterEach(() => db.client.close());

const insert = (
  kind: "routine" | "http" | "mail" | "app",
  id: string = kind,
  agentId = "a1"
) => {
  db.insert(triggers)
    .values({
      agentId,
      createdAt: NOW,
      createdBy: "u1",
      id,
      kind,
      name: id,
      workspaceId: "w1",
      ...(kind === "routine"
        ? {
            cron: "*/5 * * * *",
            nextRunAt: NEXT,
            prompt: "\n  Send the digest\nDetails",
            timezone: "UTC",
          }
        : {}),
    })
    .run();
  return id;
};
const sentence = (
  id: string,
  source: JobSentence["source"],
  when: string
): JobSentence => ({
  agent: { id: "a1", name: "Alpha" },
  asksBefore: "Acting outside its workspace",
  deliversTo: null,
  does: "Keep the harbour tidy",
  enabled: true,
  id,
  lastRunAt: null,
  lastRunOk: null,
  nextRunAt: null,
  source,
  when,
});

test("routine sentence includes prompt, schedule and latest run", async () => {
  insert("routine");
  const { runId } = await service.runNow(user, "routine");
  db.update(runRows)
    .set({ startedAt: NOW, status: "done" })
    .where(eq(runRows.id, runId))
    .run();
  expect(await service.list(user)).toEqual([
    {
      ...sentence("routine", "routine", "Every 5 minutes"),
      does: "Send the digest",
      lastRunAt: NOW,
      lastRunOk: true,
      nextRunAt: NEXT,
    },
  ]);
});
for (const [kind, when] of [
  ["http", "When its web address is called"],
  ["mail", "When mail arrives at a1@mail.example"],
  ["app", "When its app asks for it"],
] as const) {
  test(`${kind} sentence`, async () => {
    insert(kind);
    expect(await service.list(user)).toEqual([sentence(kind, kind, when)]);
  });
}
test("slack sentence uses app id, installed status and listen mode", async () => {
  db.insert(slackApps)
    .values({
      agentId: "a1",
      appId: "A1",
      botUserId: "B1",
      createdAt: NOW,
      id: "s1",
      signingSecret: "secret",
      status: "installed",
      teamId: "T1",
      workspaceId: "w1",
    })
    .run();
  expect(await service.list(user)).toEqual([
    sentence("s1", "slack", "When mentioned in Slack"),
  ]);
  db.update(slackApps).set({ listenMode: "all", status: "revoked" }).run();
  expect(await service.list(user)).toEqual([
    {
      ...sentence("s1", "slack", "When a message arrives in Slack"),
      enabled: false,
    },
  ]);
});
test("forAgent and workspace filtering and deterministic ordering", async () => {
  insert("http", "z", "a2");
  insert("http", "b");
  insert("app", "a");
  insert("routine", "later");
  insert("routine", "earlier");
  db.update(triggers)
    .set({ nextRunAt: NOW })
    .where(eq(triggers.id, "earlier"))
    .run();
  expect((await service.list(user)).map((row) => row.id)).toEqual([
    "earlier",
    "later",
    "a",
    "b",
    "z",
  ]);
  expect((await service.forAgent(user, "a2")).map((row) => row.id)).toEqual([
    "z",
  ]);
  expect(await service.list({ ...user, workspaceId: "w2" })).toEqual([]);
  expect(await service.forAgent(user, "missing")).toEqual([]);
});
test("revoked, pending and paused starts; missing slot and timezone labels", async () => {
  insert("http");
  db.update(triggers)
    .set({ revokedAt: NOW })
    .where(eq(triggers.id, "http"))
    .run();
  insert("routine");
  db.update(triggers)
    .set({ nextRunAt: null })
    .where(eq(triggers.id, "routine"))
    .run();
  expect((await service.list(user))[0]?.nextRunAt).toBe(NEXT);
  db.update(triggers)
    .set({
      cron: "0 9 * * 2",
      proposedByAgentId: "a1",
      timezone: "Australia/Sydney",
    })
    .where(eq(triggers.id, "routine"))
    .run();
  expect(await service.list(user)).toEqual([
    {
      ...sentence("routine", "routine", "Every Tuesday at 9:00 (Sydney time)"),
      does: "Send the digest",
      enabled: false,
    },
  ]);
  db.update(triggers)
    .set({ approvedAt: NOW, disabledAt: NOW })
    .where(eq(triggers.id, "routine"))
    .run();
  expect((await service.list(user))[0]?.nextRunAt).toBeNull();
});
test("job line cap, ask levels and mail address fallback", async () => {
  insert("mail");
  db.update(agents)
    .set({
      askLevel: "rarely",
      emailLocal: null,
      soul: `\n${"x".repeat(JOB_LINE_MAX_CHARS + 10)}`,
    })
    .where(eq(agents.id, "a1"))
    .run();
  expect(await service.list(user)).toEqual([
    {
      ...sentence("mail", "mail", "When mail arrives"),
      asksBefore: null,
      does: "x".repeat(JOB_LINE_MAX_CHARS),
    },
  ]);
  db.update(agents).set({ askLevel: "everything" }).run();
  expect((await service.list(user))[0]?.asksBefore).toBe("Everything it does");
  db.update(agents).set({ askLevel: "custom" }).run();
  expect((await service.list(user))[0]?.asksBefore).toBe(
    "Following its custom instructions"
  );
});
test("read-only principals can read but cannot run; refused principals cannot read", async () => {
  insert("routine");
  const readOnly: Principal = {
    ...user,
    apiKey: { access: "read", id: "key", name: "Read only" },
    via: "api_key",
  };
  expect(await service.list(readOnly)).toHaveLength(1);
  expect(await service.forAgent(readOnly, "a1")).toHaveLength(1);
  await expect(service.runNow(readOnly, "routine")).rejects.toThrow(
    ForbiddenError
  );
  for (const principal of [
    { kind: "system" },
    { ...user, via: "slack" },
    { agentId: "a1", kind: "trigger", triggerId: "http", workspaceId: "w1" },
  ] as Principal[]) {
    // biome-ignore lint/performance/noAwaitInLoops: check each principal independently
    await expect(service.list(principal)).rejects.toThrow(ForbiddenError);
    await expect(service.forAgent(principal, "a1")).rejects.toThrow(
      ForbiddenError
    );
  }
});
test("runNow starts one run per press and preserves the schedule", async () => {
  insert("routine");
  const before = db.select().from(triggers).get();
  const first = await service.runNow(user, "routine");
  expect(db.select().from(runRows).all()).toHaveLength(1);
  const second = await service.runNow(user, "routine");
  expect(second.runId).not.toBe(first.runId);
  const rows = db.select().from(runRows).all();
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row) =>
        row.actorId === "routine" &&
        row.actorKind === "trigger" &&
        row.inputText === "\n  Send the digest\nDetails"
    )
  ).toBe(true);
  expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
  expect(db.select().from(triggers).get()).toEqual(before);
  const fired = db
    .select()
    .from(eventRows)
    .all()
    .filter((row) => row.type === "trigger.fired");
  expect(fired.map((row) => row.runId).sort()).toEqual(
    [first.runId, second.runId].sort()
  );
  expect((await service.list(user))[0]?.lastRunOk).toBe(false);
});
test("runNow refuses missing, foreign, non-routine, revoked and pending jobs", async () => {
  insert("http");
  insert("routine");
  await expect(service.runNow(user, "missing")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.runNow({ ...user, workspaceId: "w2" }, "routine")
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(service.runNow(user, "http")).rejects.toMatchObject({
    code: "invalid",
  });
  db.update(triggers)
    .set({ proposedByAgentId: "a1" })
    .where(eq(triggers.id, "routine"))
    .run();
  await expect(service.runNow(user, "routine")).rejects.toMatchObject({
    code: "conflict",
  });
  db.update(triggers)
    .set({ revokedAt: NOW })
    .where(eq(triggers.id, "routine"))
    .run();
  await expect(service.runNow(user, "routine")).rejects.toMatchObject({
    code: "conflict",
  });
  expect(db.select().from(runRows).all()).toHaveLength(0);
});

test("history uses the latest trigger run, including non-routine starts", async () => {
  insert("routine");
  insert("http");
  const first = await service.runNow(user, "routine");
  const second = await service.runNow(user, "routine");
  db.update(runRows)
    .set({ startedAt: NOW, status: "done" })
    .where(eq(runRows.id, first.runId))
    .run();
  db.update(runRows)
    .set({ startedAt: NEXT, status: "failed" })
    .where(eq(runRows.id, second.runId))
    .run();
  expect((await service.list(user))[0]).toMatchObject({
    lastRunAt: NEXT,
    lastRunOk: false,
  });
  db.update(runRows)
    .set({ actorId: "http" })
    .where(eq(runRows.id, second.runId))
    .run();
  expect(await service.list(user)).toEqual([
    {
      ...sentence("routine", "routine", "Every 5 minutes"),
      does: "Send the digest",
      lastRunAt: NOW,
      lastRunOk: true,
      nextRunAt: NEXT,
    },
    {
      ...sentence("http", "http", "When its web address is called"),
      lastRunAt: NEXT,
      lastRunOk: false,
    },
  ]);
});

test("runNow can run an approved paused routine without resuming it", async () => {
  insert("routine");
  db.update(triggers).set({ disabledAt: NOW }).run();
  const before = db.select().from(triggers).get();
  await service.runNow(user, "routine");
  expect(db.select().from(runRows).all()).toHaveLength(1);
  expect(db.select().from(triggers).get()).toEqual(before);
  expect((await service.list(user))[0]).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
});
