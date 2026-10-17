import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a", "org_b"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
  };
};

const servicesFor = (): Composed =>
  composeWith({ allowedOrgIds: ALLOWED_ORG_IDS, db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

const agentInput = {
  model: "fake",
  name: "Fake echo",
  runtime: "fake",
} as const;

const routineInput = {
  cron: "0 9 * * *",
  name: "Morning digest",
  prompt: "Summarise the inbox",
} as const;

/**
 * A user, their agent and a run of that agent. An agent's run proposes
 * routines through the service, the same way a run does through its MCP tools.
 */
const proposalSetup = async () => {
  const composed = servicesFor();
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );
  const agent = await caller.agents.create(agentInput);
  const user = await composed.services.workspaces.sessionPrincipal({
    orgId: "org_a",
    userId: "user_1",
  });
  if (user?.kind !== "user") {
    throw new Error("user_1 has no workspace principal");
  }
  const started = await composed.services.runs.startRun(user, {
    agentId: agent.id,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  const run = {
    agentId: agent.id,
    kind: "run",
    runId: started.runId,
    workspaceId: user.workspaceId,
  } as const;
  return { agent, caller, composed, run };
};

test("routines.list shows a proposed routine paused and waiting for approval", async () => {
  const { agent, caller, composed, run } = await proposalSetup();
  await composed.services.routines.create(run, {
    ...routineInput,
    agentId: agent.id,
  });

  const [listed] = await caller.routines.list({});
  expect(listed).toMatchObject({
    approvedAt: null,
    name: "Morning digest",
    proposedByAgentId: agent.id,
    proposedByRunId: run.runId,
  });
  expect(listed?.disabledAt).not.toBeNull();
});

test("routines.approve enables a proposed routine", async () => {
  const { agent, caller, composed, run } = await proposalSetup();
  const proposed = await composed.services.routines.create(run, {
    ...routineInput,
    agentId: agent.id,
  });

  const approved = await caller.routines.approve({
    routineId: proposed.id,
  });
  expect(approved.disabledAt).toBeNull();
  expect(approved.approvedAt).not.toBeNull();
  expect(approved.nextRunAt).not.toBeNull();

  const [listed] = await caller.routines.list({});
  expect(listed).toMatchObject({ disabledAt: null, id: proposed.id });
  expect(listed?.approvedAt).not.toBeNull();
});

test("routines.reject removes a proposed routine from the list", async () => {
  const { agent, caller, composed, run } = await proposalSetup();
  const proposed = await composed.services.routines.create(run, {
    ...routineInput,
    agentId: agent.id,
  });

  await caller.routines.reject({ routineId: proposed.id });
  expect(await caller.routines.list({})).toEqual([]);
});

test("approve and reject on a routine a user made throw CONFLICT", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const routine = await caller.routines.create({
    ...routineInput,
    agentId: agent.id,
  });

  await expect(
    caller.routines.approve({ routineId: routine.id })
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    caller.routines.reject({ routineId: routine.id })
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await caller.routines.list({})).toHaveLength(1);
});

test("a user of another org cannot approve or reject a proposed routine", async () => {
  const { agent, composed, run } = await proposalSetup();
  const proposed = await composed.services.routines.create(run, {
    ...routineInput,
    agentId: agent.id,
  });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);

  await expect(
    other.routines.approve({ routineId: proposed.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    other.routines.reject({ routineId: proposed.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
