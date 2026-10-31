import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { a2aConnections, a2aOutbox } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import { eq } from "drizzle-orm";
import { composeWith } from "../compose.ts";
import { a2aJobs } from "./a2a.ts";
import { tickJobs } from "./jobs.ts";
import { runTick, type TickDeps } from "./registry.ts";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const WORKSPACE = "w1";

let db: ReturnType<typeof migrated>;
let deps: TickDeps;
const delivered: string[] = [];

beforeEach(async () => {
  delivered.length = 0;
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
      peerFetch: (url) => {
        delivered.push(url);
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      relay: noopRelay,
    },
  });
  deps = { clock, services };
  await db.insert(workspaces).values({
    clerkOrgId: "org_w1",
    createdAt: NOW.toISOString(),
    id: WORKSPACE,
    name: "One",
    timezone: "UTC",
  });
  await db.insert(agents).values({
    createdAt: NOW.toISOString(),
    createdBy: "u1",
    id: "a1",
    instructions: "x",
    model: "m",
    name: "A",
    runtime: "cloud",
    runtimeConfig: "{}",
    slug: "a",
    status: "active",
    workspaceId: WORKSPACE,
  });
});

test("every A2A job runs on an empty database and is registered once", async () => {
  const report = await runTick(a2aJobs, deps);

  expect(report.jobs.map((job) => job.name).toSorted()).toEqual([
    "a2a.invites-expire",
    "a2a.outbound-approvals",
    "a2a.outbound-poll",
    "a2a.outbound-wakes",
    "a2a.outbox",
  ]);
  expect(report.jobs.every((job) => job.ok)).toBe(true);
  // Two jobs with one name would throw here.
  const all = await runTick(tickJobs, deps);
  expect(all.jobs.filter((job) => job.name.startsWith("a2a."))).toHaveLength(6);
});

test("an invite that ran out is ended by the tick", async () => {
  await db.insert(a2aConnections).values({
    createdAt: "2026-10-20T10:00:00.000Z",
    createdBy: "u1",
    id: "con_old",
    inviteExpiresAt: "2026-10-27T10:00:00.000Z",
    inviteTokenHash: "hash",
    localAgentId: "a1",
    peerKind: "harbourmaster",
    slug: "invite-old",
    status: "inviting",
    workspaceId: WORKSPACE,
  });
  await db.insert(a2aConnections).values({
    createdAt: "2026-10-31T10:00:00.000Z",
    createdBy: "u1",
    id: "con_new",
    inviteExpiresAt: "2026-11-07T10:00:00.000Z",
    inviteTokenHash: "hash2",
    localAgentId: "a1",
    peerKind: "harbourmaster",
    slug: "invite-new",
    status: "inviting",
    workspaceId: WORKSPACE,
  });

  await runTick(a2aJobs, deps);

  const status = async (id: string) =>
    (
      await db
        .select({ status: a2aConnections.status })
        .from(a2aConnections)
        .where(eq(a2aConnections.id, id))
    )[0]?.status;
  expect(await status("con_old")).toBe("revoked");
  expect(await status("con_new")).toBe("inviting");
});

test("a due outbox row is delivered by the tick and then gone", async () => {
  await db.insert(a2aConnections).values({
    createdAt: NOW.toISOString(),
    createdBy: "u1",
    id: "con_x",
    localAgentId: "a1",
    peerKind: "a2a_outbound",
    slug: "x",
    status: "revoked",
    workspaceId: WORKSPACE,
  });
  await db.insert(a2aOutbox).values({
    attempts: 0,
    body: "{}",
    connectionId: "con_x",
    createdAt: NOW.toISOString(),
    headers: null,
    id: "obx_1",
    kind: "pair_revoke",
    nextAttemptAt: NOW.toISOString(),
    url: "https://peer.test/a2a/pub/pair/revoke",
    workspaceId: WORKSPACE,
  });

  await runTick(a2aJobs, deps);

  expect(delivered).toEqual(["https://peer.test/a2a/pub/pair/revoke"]);
  expect(await db.select().from(a2aOutbox)).toEqual([]);
});
