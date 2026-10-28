import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  artifactComments,
  artifactMembers,
  guestIdentities,
  guestSessions,
} from "@repo/db/schema/live-artifacts";
import { machines } from "@repo/db/schema/machines";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "../agents.ts";
import { hashToken } from "../crypto.ts";
import { createEventsService } from "../events.ts";
import { createRunsService } from "../runs.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createScopedGuestComments } from "./scoped-comments.ts";

const W = "w1";
const START = "2026-10-16T10:00:00.000Z";
const A = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const token = `hm_guest_${"a".repeat(43)}`;
let db: ReturnType<typeof migrated>;
let nowMs: number;
let agentId: string;
let events: ReturnType<typeof createEventsService>;
const clock = { now: () => new Date(nowMs), sleep: () => Promise.resolve() };
const atomic = (stmts: Parameters<ReturnType<typeof sqliteAtomic>>[0]) =>
  sqliteAtomic(db)(stmts);
let svc: ReturnType<typeof createRunsService>;
const grant = {
  artifactId: A,
  expiresAt: "2026-10-17T10:00:00.000Z",
  guestId: "g1",
  role: "commenter" as const,
  workspaceId: W,
};

const addArtifact = (id: string) =>
  db
    .insert(artifacts)
    .values({
      audience: "private",
      createdAt: START,
      createdById: "u1",
      createdByKind: "user",
      id,
      kind: "document",
      ownerUserId: "u1",
      title: "Doc",
      updatedAt: START,
      workspaceId: W,
    })
    .run();

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  db.insert(workspaceRows)
    .values({
      clerkOrgId: "org",
      createdAt: START,
      id: W,
      name: W,
      timezone: "UTC",
    })
    .run();
  db.update(workspaceRows).set({ liveGuestsEnabled: true }).run();
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "h",
      enrolledBy: "u1",
      id: "m1",
      name: "m1",
      singleUser: false,
      status: "online",
      workspaceId: W,
    })
    .run();
  agentId = (
    await agents.create(
      { kind: "user", userId: "u1", via: "session", workspaceId: W },
      { machineId: "m1", model: "m", name: "Spy", runtime: "machine" }
    )
  ).id;
  svc = createRunsService({
    adapters: [
      {
        cancel: () => Promise.resolve(),
        dispatch: () => Promise.resolve(),
        kind: "machine",
      },
    ],
    atomic,
    authorizeGuestGrant: () => Promise.resolve(),
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
    guestRuntimeReady: () => true,
    guestsOff: () => false,
  } as never);
  addArtifact(A);
  addArtifact(A2);
  db.insert(guestIdentities)
    .values({
      createdAt: START,
      displayName: "Ana",
      email: "a@x.com",
      id: "g1",
      workspaceId: W,
    })
    .run();
  db.insert(guestIdentities)
    .values({
      createdAt: START,
      displayName: "Bob",
      email: "b@x.com",
      id: "g2",
      workspaceId: W,
    })
    .run();
  for (const [id, art, g] of [
    ["gm1", A, "g1"],
    ["gm2", A, "g2"],
    ["gm3", A2, "g1"],
  ] as const) {
    db.insert(artifactMembers)
      .values({
        agentRunsPerDay: 3,
        artifactId: art,
        createdAt: START,
        createdBy: "u1",
        expiresAt: grant.expiresAt,
        guestId: g,
        id,
        principalKind: "guest",
        role: "commenter",
        workspaceId: W,
      })
      .run();
  }
  db.insert(guestSessions)
    .values({
      createdAt: START,
      expiresAt: "2099-01-01T00:00:00.000Z",
      guestId: "g1",
      id: "gs1",
      lastUsedAt: START,
      tokenHash: await hashToken(token),
      workspaceId: W,
    })
    .run();
});

const comments = () =>
  createScopedGuestComments({
    atomic,
    clock,
    db,
    events,
    guestsOff: () => false,
    runs: svc,
  });

const startAndClaim = async () => {
  const s = await svc.startForGuest(
    grant,
    {
      agentId,
      input: { text: "hi" },
      reply: { kind: "none" },
      requestId: "r1",
      session: { externalKey: A, origin: "artifact" },
    } as never,
    { guestSessionToken: token, offerLater: true }
  );
  await svc.claimRun(SYSTEM_PRINCIPAL, s.runId);
  const { run } = await svc.guestExecution(SYSTEM_PRINCIPAL, s.runId);
  return {
    agentId,
    kind: "run" as const,
    runId: run.id,
    scopeArtifactId: A,
    workspaceId: W,
  };
};

describe("scoped guest comments", () => {
  test("a new anchored thread keeps its quote", async () => {
    const principal = await startAndClaim();
    const position = {
      assoc: -1,
      item: { client: 1, clock: 2 },
      tname: "content",
    };
    const anchor = {
      end: position,
      kind: "document",
      start: position,
    } as never;
    const out = await comments().apply(
      principal,
      { artifactId: A, body: "note" },
      "c1",
      anchor,
      "hello"
    );
    expect(out.thread.quote).toBe("hello");
  });

  test("replies leave out soft-deleted comments", async () => {
    const principal = await startAndClaim();
    const first = await comments().apply(
      principal,
      { artifactId: A, body: "one" },
      "c1"
    );
    db.insert(artifactComments)
      .values({
        authorId: "u1",
        authorKind: "user",
        body: "secret",
        createdAt: START,
        deletedAt: START,
        id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        threadId: first.thread.id,
        workspaceId: W,
      })
      .run();
    const out = await comments().apply(
      principal,
      { artifactId: A, body: "two", threadId: first.thread.id },
      "c2"
    );
    expect(out.thread.comments.map((c) => c.body)).toEqual(["one", "two"]);
  });
});
