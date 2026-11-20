import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createLibraryAudience, type LibraryAudience } from "./audience.ts";

const WORKSPACE = "w1";
const AGENT = "agent_scout";
const SESSION = "s1";
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
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: SESSION,
      origin: "ui",
      workspaceId: WORKSPACE,
    })
    .run();
  const machineRuns = [
    { claimedBy: "machine_a", id: "run_a", onBehalfOfUserId: "user_a" },
    { claimedBy: "machine_b", id: "run_b", onBehalfOfUserId: "user_b" },
    { claimedBy: "machine_none", id: "run_none", onBehalfOfUserId: null },
  ];
  for (const run of machineRuns) {
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
        sessionId: SESSION,
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
    machine_none: [SHARED],
  });
});

test("a private memory file reaches only the run for its person", async () => {
  const result = await audience(change([PRIVATE_A]));
  expect(byMachine(result)).toEqual({ machine_a: [PRIVATE_A] });
});

test("a change with a shared and a private file gives user_b only the shared file", async () => {
  const result = await audience(change([SHARED, PRIVATE_A]));
  expect(byMachine(result)).toEqual({
    machine_a: [SHARED, PRIVATE_A],
    machine_b: [SHARED],
    machine_none: [SHARED],
  });
});
