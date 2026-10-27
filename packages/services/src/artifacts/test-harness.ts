// Shared setup for the artifacts service tests (A.2): an in-memory database
// with one workspace, two agents, sessions and runs, and the service wired to
// in-memory blobs and the real library service.

import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentLibraryAccess } from "@repo/db/schema/library";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import { systemClock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createArtifactsService } from "./service.ts";

const NOW = "2026-10-27T00:00:00.000Z";

export const WORKSPACE = "w1";

type User = Extract<Principal, { kind: "user" }>;
type Run = Extract<Principal, { kind: "run" }>;

const user = (userId: string, isAdmin = false): User => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId: WORKSPACE,
});

const run = (runId: string, agentId: string): Run => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
});

/** The people and runs the seed knows. */
export const principals = {
  admin: user("adm", true),
  /** Agent a1 in the shared session `s-shared`, on behalf of u1. */
  agentOne: run("r-shared", "a1"),
  /** Agent a1 in the `ui` session `s-ui` of u1. */
  agentOneInUi: run("r-ui", "a1"),
  /** Agent a2 in `s-two`, with no person behind it. */
  agentTwo: run("r-two", "a2"),
  /** u1 with a read-only API key. */
  keyReader: {
    ...user("u1"),
    apiKey: { access: "read" as const, id: "k1" },
    via: "api_key" as const,
  },
  otherWorkspace: { ...user("u1"), workspaceId: "w2" },
  owner: user("u1"),
  stranger: user("u2"),
};

export const bytes = (text: string) => new TextEncoder().encode(text);

export const harness = () => {
  const db = migrated();
  db.insert(workspaces)
    .values([
      {
        clerkOrgId: "org_w1",
        createdAt: NOW,
        id: WORKSPACE,
        name: "W1",
        timezone: "UTC",
      },
      {
        clerkOrgId: "org_w2",
        createdAt: NOW,
        id: "w2",
        name: "W2",
        timezone: "UTC",
      },
    ])
    .run();
  for (const [id, slug] of [
    ["a1", "agent-one"],
    ["a2", "agent-two"],
  ] as const) {
    db.insert(agents)
      .values({
        createdAt: NOW,
        createdBy: "u1",
        id,
        instructions: "",
        model: "m",
        name: `Agent ${id}`,
        runtime: "fake",
        runtimeConfig: "{}",
        slug,
        status: "active",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const session = (
    id: string,
    agentId: string,
    origin: string,
    isPrivate = false
  ) =>
    db
      .insert(sessions)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId,
        createdAt: NOW,
        id,
        origin,
        private: isPrivate,
        workspaceId: WORKSPACE,
      })
      .run();
  session("s-shared", "a1", "slack");
  session("s-ui", "a1", "ui");
  session("s-private", "a1", "slack", true);
  session("s-two", "a2", "slack");
  const runRow = (
    id: string,
    agentId: string,
    sessionId: string,
    onBehalfOfUserId: string | null
  ) =>
    db
      .insert(runs)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId,
        createdAt: NOW,
        id,
        inputText: "",
        onBehalfOfUserId,
        sessionId,
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
  runRow("r-shared", "a1", "s-shared", "u1");
  runRow("r-ui", "a1", "s-ui", "u1");
  runRow("r-private", "a1", "s-private", "u1");
  runRow("r-two", "a2", "s-two", null);

  const blobs = memoryLibraryBlobs();
  const events = createEventsService({
    blobs: { get: async () => null, put: async () => undefined },
    db,
  });
  const atomic = sqliteAtomic(db);
  const library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock: systemClock,
    db,
    events,
  });
  const service = createArtifactsService({
    atomic,
    blobs,
    clock: systemClock,
    db,
    events,
    library,
  });
  /** Lets agent `agentId` read or write the library folder `path`. */
  const grant = (agentId: string, path: string, mode: "read" | "write") =>
    db
      .insert(agentLibraryAccess)
      .values({ agentId, createdAt: NOW, mode, path, workspaceId: WORKSPACE })
      .run();
  return { atomic, blobs, db, events, grant, library, service };
};

export type Harness = ReturnType<typeof harness>;

/** A page with an `index.html` holding `body`. */
export const page = (body = "<h1>Hello</h1>") => [
  { path: "index.html", text: body },
];
