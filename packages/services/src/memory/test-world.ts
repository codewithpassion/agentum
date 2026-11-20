// A workspace, two agents, a few people and runs, and the real library and
// memory services over an in-memory database. For the memory tests only.
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "../library/memory.ts";
import { createLibraryService, type LibraryBlobs } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createMemoryService } from "./service.ts";

export const WORKSPACE = "w1";
export const AGENT = "agent_scout";
export const OTHER_AGENT = "agent_other";
export const OWNER = "user_owner";
export const USER_A = "user_a";
export const USER_B = "user_b";
const START = Date.parse("2026-11-20T10:00:00.000Z");

export const MEMORY = "agents/scout/memory";

/** A session or run the tests write notes from. */
export const SESSION = {
  mail: "s_mail",
  peer: "s_peer",
  privateA: "s_private_a",
  privateB: "s_private_b",
  ui: "s_ui",
} as const;
export const RUN = {
  mail: "r_mail",
  peer: "r_peer",
  privateA: "r_private_a",
  privateB: "r_private_b",
  ui: "r_ui",
  web: "r_web",
} as const;

export const person = (
  userId: string,
  extra: Partial<Extract<Principal, { kind: "user" }>> = {}
): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId: WORKSPACE,
  ...extra,
});

export const run = (
  runId: string,
  agentId = AGENT,
  extra: { dryRun?: boolean } = {}
): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
  ...extra,
});

export const text = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes);

/** The error a promise rejects with, or null when it resolves. */
export const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

interface SessionSeed {
  actorId?: string;
  id: string;
  origin: string;
  private?: boolean;
}
interface RunSeed {
  actor?: { id: string; kind: string };
  id: string;
  onBehalfOfUserId: string | null;
  parentRunId?: string;
  sessionId: string;
}

export const makeWorld = (
  options: {
    atomic?: ReturnType<typeof sqliteAtomic>;
    blobs?: (inner: MemoryLibraryBlobs) => LibraryBlobs;
  } = {}
) => {
  const db = migrated();
  const baseBlobs = memoryLibraryBlobs();
  let tick = START;
  const clock: Clock = {
    now: () => {
      tick += 1;
      return new Date(tick);
    },
    sleep: () => Promise.resolve(),
  };
  const atomic = options.atomic ?? sqliteAtomic(db);
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  const library = createLibraryService({
    atomic,
    blobs: options.blobs ? options.blobs(baseBlobs) : baseBlobs,
    clock,
    db,
    events: eventsService,
  });
  const service = createMemoryService({
    atomic,
    clock,
    db,
    events: eventsService,
    library,
  });

  const createdAt = new Date(START).toISOString();
  db.insert(workspaces)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  for (const [id, slug] of [
    [AGENT, "scout"],
    [OTHER_AGENT, "other"],
  ] as const) {
    db.insert(agents)
      .values({
        createdAt,
        createdBy: OWNER,
        id,
        instructions: "",
        model: "m",
        name: slug,
        runtime: "fake",
        runtimeConfig: "{}",
        slug,
        status: "active",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const seedSession = (seed: SessionSeed) =>
    db
      .insert(sessions)
      .values({
        actorId: seed.actorId ?? USER_A,
        actorKind: "user",
        agentId: AGENT,
        createdAt,
        id: seed.id,
        origin: seed.origin,
        private: seed.private ?? false,
        workspaceId: WORKSPACE,
      })
      .run();
  const seedRun = (seed: RunSeed) => {
    const actor = seed.actor ?? { id: USER_A, kind: "user" };
    db.insert(runs)
      .values({
        actorId: actor.id,
        actorKind: actor.kind,
        agentId: AGENT,
        createdAt,
        id: seed.id,
        inputText: "hi",
        onBehalfOfUserId: seed.onBehalfOfUserId,
        parentRunId: seed.parentRunId ?? null,
        sessionId: seed.sessionId,
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
  };
  seedSession({ id: SESSION.ui, origin: "ui" });
  seedSession({
    id: SESSION.privateA,
    origin: "ui",
    private: true,
  });
  seedSession({
    actorId: USER_B,
    id: SESSION.privateB,
    origin: "ui",
    private: true,
  });
  seedSession({ id: SESSION.mail, origin: "mail" });
  seedSession({ id: SESSION.peer, origin: "a2a" });
  seedRun({ id: RUN.ui, onBehalfOfUserId: USER_A, sessionId: SESSION.ui });
  seedRun({ id: RUN.web, onBehalfOfUserId: USER_A, sessionId: SESSION.ui });
  seedRun({
    id: RUN.privateA,
    onBehalfOfUserId: USER_A,
    sessionId: SESSION.privateA,
  });
  seedRun({
    actor: { id: USER_B, kind: "user" },
    id: RUN.privateB,
    onBehalfOfUserId: USER_B,
    sessionId: SESSION.privateB,
  });
  seedRun({ id: RUN.mail, onBehalfOfUserId: null, sessionId: SESSION.mail });
  seedRun({
    actor: { id: "conn_1", kind: "peer" },
    id: RUN.peer,
    onBehalfOfUserId: null,
    sessionId: SESSION.peer,
  });
  // A run the agent's own run set going, a child of the peer's run.
  seedRun({
    id: "r_peer_child",
    onBehalfOfUserId: null,
    parentRunId: RUN.peer,
    sessionId: SESSION.ui,
  });
  // A web_fetch call, which makes this run's notes web-sourced.
  db.insert(events)
    .values({
      actorId: AGENT,
      actorKind: "agent",
      agentId: AGENT,
      createdAt,
      id: "ev_web_1",
      payload: JSON.stringify({ via: "web_fetch" }),
      runId: RUN.web,
      sessionId: SESSION.ui,
      type: "network.request",
      workspaceId: WORKSPACE,
    })
    .run();

  return { atomic, baseBlobs, clock, db, library, service };
};

export type World = ReturnType<typeof makeWorld>;
