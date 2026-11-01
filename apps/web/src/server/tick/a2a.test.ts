import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { a2aConnections, a2aOutbox } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { composeWith } from "../compose.ts";
import { a2aJobs } from "./a2a.ts";
import { tickJobs } from "./jobs.ts";
import { runTick, type TickDeps } from "./registry.ts";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const WORKSPACE = "w1";
const CARD_URL = "https://peer.test/.well-known/agent-card.json";
const DAY_AND_MORE_AGO = "2026-10-30T10:00:00.000Z";
const ADMIN: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

const cardAt = (url: string) => ({
  capabilities: { pushNotifications: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  description: "Hermes on Sam's box",
  name: "Hermes",
  skills: [{ description: "Does things", id: "s", name: "s", tags: ["t"] }],
  supportedInterfaces: [
    { protocolBinding: "JSONRPC", protocolVersion: "1.0", url },
  ],
  version: "1.0.0",
});

let db: ReturnType<typeof migrated>;
let deps: TickDeps;
const delivered: string[] = [];
/** What the peer answers to a card fetch. */
let cardAnswer: () => Response;
let cardFetches = 0;

beforeEach(async () => {
  delivered.length = 0;
  cardFetches = 0;
  cardAnswer = () => {
    cardFetches += 1;
    return Response.json(cardAt("https://peer.test/a2a"));
  };
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
        if (url === CARD_URL) {
          return Promise.resolve(cardAnswer());
        }
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
    "a2a.card-refresh",
    "a2a.invites-expire",
    "a2a.outbound-approvals",
    "a2a.outbound-poll",
    "a2a.outbound-wakes",
    "a2a.outbox",
  ]);
  expect(report.jobs.every((job) => job.ok)).toBe(true);
  // Two jobs with one name would throw here.
  const all = await runTick(tickJobs, deps);
  expect(all.jobs.filter((job) => job.name.startsWith("a2a."))).toHaveLength(7);
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

/** An active outside agent whose card was last fetched `fetchedAt`. */
const outsideAgent = async (fetchedAt: string) => {
  const added = await deps.services.connections.addOutbound(ADMIN, {
    agentId: "a1",
    cardUrl: CARD_URL,
  });
  await db
    .update(a2aConnections)
    .set({ peerCardFetchedAt: fetchedAt })
    .where(eq(a2aConnections.id, added.id));
  return added.id;
};

const rowOf = async (id: string) =>
  (await db.select().from(a2aConnections).where(eq(a2aConnections.id, id)))[0];

const reapprovals = async () =>
  await db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "a2a.connection_reapproval_needed"));

test("a card that moved to another origin sends the connection back to a person, and nothing more goes out", async () => {
  const id = await outsideAgent(DAY_AND_MORE_AGO);
  cardAnswer = () => Response.json(cardAt("https://elsewhere.example.org/a2a"));

  await runTick(a2aJobs, deps);

  expect((await rowOf(id))?.status).toBe("needs_approval");
  expect(await reapprovals()).toHaveLength(1);
  expect(delivered).toEqual([]);
  expect(await db.select().from(a2aOutbox)).toEqual([]);
});

test("an unchanged card stays active with a new fetch time", async () => {
  const id = await outsideAgent(DAY_AND_MORE_AGO);
  cardFetches = 0;

  await runTick(a2aJobs, deps);

  expect(cardFetches).toBe(1);
  const row = await rowOf(id);
  expect(row?.status).toBe("active");
  expect(row?.peerCardFetchedAt).toBe(NOW.toISOString());
  expect(await reapprovals()).toHaveLength(0);
});

test("a card fetch that fails leaves the row as it was", async () => {
  const id = await outsideAgent(DAY_AND_MORE_AGO);
  const before = await rowOf(id);
  cardAnswer = () => new Response("down", { status: 503 });

  const report = await runTick(a2aJobs, deps);

  expect(report.jobs.every((job) => job.ok)).toBe(true);
  const after = await rowOf(id);
  expect(after?.peerCardTriedAt).toBe(NOW.toISOString());
  expect({ ...after, peerCardTriedAt: null }).toEqual({
    ...before,
    peerCardTriedAt: null,
  });
});

test("a card fetched within the day is left alone", async () => {
  const id = await outsideAgent("2026-11-01T01:00:00.000Z");
  cardAnswer = () => Response.json(cardAt("https://elsewhere.example.org/a2a"));

  await runTick(a2aJobs, deps);

  expect((await rowOf(id))?.status).toBe("active");
});
