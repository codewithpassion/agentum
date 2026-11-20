import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createLibraryAudience, type LibraryAudience } from "./audience.ts";

const WORKSPACE = "w1";
const AGENT = "agent_scout";
const START = "2026-10-16T10:00:00.000Z";
const SHARED = "agents/scout/memory/people.md";
const PRIVATE_A = "agents/scout/memory/private/user_a.md";

let db: ReturnType<typeof migrated>;
let audience: ReturnType<typeof createLibraryAudience>;

const change = (paths: string[]) => ({
  byRunId: null,
  paths,
  workspaceId: WORKSPACE,
});

/** The paths each machine hears about, keyed by machine id. */
const byMachine = (result: LibraryAudience): Record<string, string[]> =>
  Object.fromEntries(
    result.machines.map((machine) => [machine.machineId, machine.paths])
  );

beforeEach(() => {
  db = migrated();
  audience = createLibraryAudience({ db });
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: AGENT,
      instructions: "",
      model: "m",
      name: "Scout",
      runtime: "machine",
      runtimeConfig: "{}",
      slug: "scout",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  // Each run has a session of its own, started by the person it runs for.
  const machineRuns = [
    {
      claimedBy: "machine_a",
      id: "run_a",
      onBehalfOfUserId: "user_a",
      origin: "ui",
      private: false,
    },
    {
      claimedBy: "machine_b",
      id: "run_b",
      onBehalfOfUserId: "user_b",
      origin: "ui",
      private: false,
    },
    {
      claimedBy: "machine_none",
      id: "run_none",
      onBehalfOfUserId: null,
      origin: "ui",
      private: false,
    },
    // user_a started a Slack channel thread and a team room post. Both are shared.
    {
      claimedBy: "machine_slack",
      id: "run_slack",
      onBehalfOfUserId: "user_a",
      origin: "slack",
      private: false,
    },
    {
      claimedBy: "machine_room",
      id: "run_room",
      onBehalfOfUserId: "user_a",
      origin: "inbox",
      private: false,
    },
    // user_a's Slack DM is private to her.
    {
      claimedBy: "machine_dm",
      id: "run_dm",
      onBehalfOfUserId: "user_a",
      origin: "slack",
      private: true,
    },
  ];
  for (const run of machineRuns) {
    db.insert(sessionRows)
      .values({
        actorId: run.onBehalfOfUserId ?? "u1",
        actorKind: "user",
        agentId: AGENT,
        createdAt: START,
        id: `s_${run.id}`,
        origin: run.origin,
        private: run.private,
        workspaceId: WORKSPACE,
      })
      .run();
    db.insert(runRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId: AGENT,
        claimedBy: run.claimedBy,
        createdAt: START,
        id: run.id,
        inputText: "hi",
        onBehalfOfUserId: run.onBehalfOfUserId,
        sessionId: `s_${run.id}`,
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
  }
});

test("a shared memory file reaches every running machine run of the agent", async () => {
  const result = await audience(change([SHARED]));
  expect(result.cloud).toEqual([]);
  expect(byMachine(result)).toEqual({
    machine_a: [SHARED],
    machine_b: [SHARED],
    machine_dm: [SHARED],
    machine_none: [SHARED],
    machine_room: [SHARED],
    machine_slack: [SHARED],
  });
});

test("a private memory file reaches only a run for its person whose session is private or ui", async () => {
  const result = await audience(change([PRIVATE_A]));
  // Not machine_slack or machine_room: user_a started them, but they are shared sessions.
  expect(byMachine(result)).toEqual({
    machine_a: [PRIVATE_A],
    machine_dm: [PRIVATE_A],
  });
});

test("a private memory file skips a run in a session whose actor is another person", async () => {
  db.update(sessionRows)
    .set({ actorId: "user_b" })
    .where(eq(sessionRows.id, "s_run_dm"))
    .run();
  const result = await audience(change([PRIVATE_A]));
  expect(byMachine(result)).toEqual({ machine_a: [PRIVATE_A] });
});

test("a change with a shared and a private file gives user_b only the shared file", async () => {
  const result = await audience(change([SHARED, PRIVATE_A]));
  expect(byMachine(result)).toEqual({
    machine_a: [SHARED, PRIVATE_A],
    machine_b: [SHARED],
    machine_dm: [SHARED, PRIVATE_A],
    machine_none: [SHARED],
    machine_room: [SHARED],
    machine_slack: [SHARED],
  });
});
