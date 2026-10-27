// Shared setup for the skills store tests: an in-memory database with the real
// migrations, a library and a store over in-memory blobs, two workspaces and
// a few agents and runs.
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import { systemClock } from "../runs/types.ts";
import { createSkillsStoreService } from "../skills-store.ts";
import type { Principal } from "../workspaces.ts";
import type { GithubSkillFetcher } from "./github.ts";
import { memorySkillBlobs } from "./memory.ts";

export const W1 = "w1";
export const W2 = "w2";
/** Agents a1 and a2 are in W1, b1 is in W2. Run r1 belongs to a1, r2 to a2, r3 to b1. */
export const A1 = "a1";
export const A2 = "a2";
export const B1 = "b1";
export const R1 = "r1";
export const R2 = "r2";
export const R3 = "r3";
const START = "2026-10-17T10:00:00.000Z";

export const user = (workspaceId = W1, userId = "u1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

/** A read-only API key of a user. */
export const readOnlyUser = (): Principal => ({
  apiKey: { access: "read", id: "k1" },
  kind: "user",
  userId: "u1",
  via: "api_key",
  workspaceId: W1,
});

export const run = (agentId = A1, runId = R1, workspaceId = W1): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId,
});

export const bytes = (value: string) => new TextEncoder().encode(value);
export const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/** A SKILL.md that passes today's checks for the skill `name`. */
export const skillMd = (name: string, body = "Do the thing."): string =>
  `---\nname: ${name}\ndescription: Describes ${name}.\n---\n\n# ${name}\n\n${body}\n`;

/** The error a promise rejects with, or null when it resolves. */
export const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

export const setup = (
  github?: GithubSkillFetcher,
  onDeleted?: Parameters<typeof createSkillsStoreService>[0]["onDeleted"]
) => {
  const db = migrated();
  const atomic = sqliteAtomic(db);
  for (const id of [W1, W2]) {
    db.insert(workspaceRows)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: START,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  const seedAgent = (id: string, workspaceId: string) =>
    db
      .insert(agentRows)
      .values({
        createdAt: START,
        createdBy: "u1",
        id,
        instructions: "",
        model: "m",
        name: id,
        runtime: "fake",
        runtimeConfig: "{}",
        slug: id,
        status: "active",
        workspaceId,
      })
      .run();
  seedAgent(A1, W1);
  seedAgent(A2, W1);
  seedAgent(B1, W2);
  for (const [runId, agentId, workspaceId] of [
    [R1, A1, W1],
    [R2, A2, W1],
    [R3, B1, W2],
  ] as const) {
    db.insert(sessionRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId,
        createdAt: START,
        id: `s-${runId}`,
        origin: "ui",
        workspaceId,
      })
      .run();
    db.insert(runRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId,
        createdAt: START,
        id: runId,
        inputFileIds: "[]",
        inputText: "hi",
        outputFileIds: "[]",
        sessionId: `s-${runId}`,
        status: "running",
        workspaceId,
      })
      .run();
  }
  const events = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  const libraryBlobs = memoryLibraryBlobs();
  const library = createLibraryService({
    atomic,
    blobs: libraryBlobs,
    clock: systemClock,
    db,
    events,
  });
  const blobs = memorySkillBlobs();
  const service = createSkillsStoreService({
    atomic,
    blobs,
    clock: systemClock,
    db,
    events,
    github,
    library,
    onDeleted,
  });
  return { atomic, blobs, db, events, library, libraryBlobs, service };
};

/** A new skill from a person, with a valid SKILL.md and the extra files given as path to text. */
export const createSkill = (
  service: ReturnType<typeof setup>["service"],
  name: string,
  extra: Record<string, string> = {},
  principal: Principal = user()
) =>
  service.create(principal, {
    files: [
      { content: skillMd(name), path: "SKILL.md" },
      ...Object.entries(extra).map(([path, content]) => ({ content, path })),
    ],
    message: "First version",
    name,
  });
