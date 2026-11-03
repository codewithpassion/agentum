import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ORG_IDS = ["org_a", "org_b"];

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated(ORG_IDS);
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

const servicesFor = (): Composed => composeWith({ db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

const agentInput = {
  model: "fake",
  name: "Fake echo",
  runtime: "fake",
} as const;

const TRIGGER_PREFIX = "ag_trg_";

const secretOf = (secret: string | null): string => {
  if (secret === null) {
    throw new Error("expected a secret");
  }
  return secret;
};

test("create returns an ag_trg_ secret, and list shows the trigger without it", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({ ...agentInput, name: "Echo" });

  const { secret, trigger } = await caller.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });
  expect(secret).not.toBeNull();
  expect(secret?.startsWith(TRIGGER_PREFIX)).toBe(true);
  expect(trigger).toMatchObject({
    agentId: agent.id,
    agentName: "Echo",
    kind: "http",
    name: "webhook",
    revokedAt: null,
  });
  expect(trigger.tokenPrefix).toBe(
    secretOf(secret).slice(0, TRIGGER_PREFIX.length + 4)
  );

  const triggers = await caller.triggers.list({});
  expect(triggers).toHaveLength(1);
  expect(triggers[0]).toMatchObject({ id: trigger.id, name: "webhook" });
  expect(Object.keys(triggers[0] ?? {})).not.toContain("tokenHash");
  expect(Object.keys(triggers[0] ?? {})).not.toContain("secret");
  expect(JSON.stringify(triggers)).not.toContain(secret);
});

test("list filters by agentId", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const first = await caller.agents.create({ ...agentInput, name: "First" });
  const second = await caller.agents.create({ ...agentInput, name: "Second" });
  await caller.triggers.create({ agentId: first.id, name: "one" });
  const { trigger: onSecond } = await caller.triggers.create({
    agentId: second.id,
    name: "two",
  });

  const filtered = await caller.triggers.list({ agentId: second.id });
  expect(filtered.map((row) => row.id)).toEqual([onSecond.id]);
  expect(await caller.triggers.list({})).toHaveLength(2);
});

test("revoke sets revokedAt, and a second revoke keeps the first timestamp", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const { trigger } = await caller.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });

  await caller.triggers.revoke({ triggerId: trigger.id });
  const [afterFirst] = await caller.triggers.list({});
  expect(afterFirst?.revokedAt).not.toBeNull();

  // Wait so a second revoke would get a later timestamp if it overwrote.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await caller.triggers.revoke({ triggerId: trigger.id });
  const [afterSecond] = await caller.triggers.list({});
  expect(afterSecond?.revokedAt).toBe(afterFirst?.revokedAt ?? null);
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(
    caller.triggers.create({ agentId: "missing", name: "webhook" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.triggers.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.triggers.revoke({ triggerId: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a caller in an org outside ORG_IDS gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_c", userId: "user_3" });

  await expect(
    caller.triggers.create({ agentId: "missing", name: "webhook" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(caller.triggers.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.triggers.revoke({ triggerId: "missing" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("a user of another org with a workspace row cannot see, revoke or create on the first org's triggers", async () => {
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" });
  const agent = await owner.agents.create(agentInput);
  const { trigger } = await owner.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });

  expect(await other.triggers.list({})).toEqual([]);
  await expect(
    other.triggers.revoke({ triggerId: trigger.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    other.triggers.create({ agentId: agent.id, name: "stolen" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const [still] = await owner.triggers.list({});
  expect(still?.revokedAt).toBeNull();
});

/**
 * A user and an agent, plus a run of that agent. An agent's run proposes
 * triggers through the service, the same way a run does through its MCP tools.
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

test("a run's proposed trigger waits paused, and approve mints a secret once", async () => {
  const { agent, caller, composed, run } = await proposalSetup();
  const proposed = await composed.services.triggers.create(run, {
    agentId: agent.id,
    name: "proposed",
  });
  expect(proposed.secret).toBeNull();
  expect(proposed.trigger).toMatchObject({
    proposedByAgentId: agent.id,
    proposedByRunId: run.runId,
    tokenPrefix: "",
  });
  expect(proposed.trigger.disabledAt).not.toBeNull();

  const approved = await caller.triggers.approve({
    triggerId: proposed.trigger.id,
  });
  expect(approved.secret?.startsWith(TRIGGER_PREFIX)).toBe(true);
  expect(approved.trigger.disabledAt).toBeNull();
  expect(approved.trigger.approvedAt).not.toBeNull();
  expect(approved.trigger.tokenPrefix).toBe(
    secretOf(approved.secret).slice(0, TRIGGER_PREFIX.length + 4)
  );

  const [listed] = await caller.triggers.list({});
  expect(listed?.tokenPrefix).toBe(approved.trigger.tokenPrefix);
  expect(Object.keys(listed ?? {})).not.toContain("secret");
  expect(JSON.stringify(listed)).not.toContain(approved.secret ?? "");
});

test("reject revokes a proposed trigger", async () => {
  const { agent, caller, composed, run } = await proposalSetup();
  const { trigger } = await composed.services.triggers.create(run, {
    agentId: agent.id,
    name: "proposed",
  });

  const rejected = await caller.triggers.reject({ triggerId: trigger.id });
  expect(rejected.revokedAt).not.toBeNull();
  await expect(
    caller.triggers.approve({ triggerId: trigger.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("approve and reject on a trigger a user made throw CONFLICT", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const { trigger } = await caller.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });

  await expect(
    caller.triggers.approve({ triggerId: trigger.id })
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    caller.triggers.reject({ triggerId: trigger.id })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a user of another org cannot approve a proposed trigger", async () => {
  const { agent, composed, run } = await proposalSetup();
  const { trigger } = await composed.services.triggers.create(run, {
    agentId: agent.id,
    name: "proposed",
  });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);

  await expect(
    other.triggers.approve({ triggerId: trigger.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("setEnabled pauses and resumes a user's trigger, with no secret", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create(agentInput);
  const { trigger } = await caller.triggers.create({
    agentId: agent.id,
    name: "webhook",
  });

  const paused = await caller.triggers.setEnabled({
    enabled: false,
    triggerId: trigger.id,
  });
  expect(paused.secret).toBeNull();
  expect(paused.trigger.disabledAt).not.toBeNull();

  const resumed = await caller.triggers.setEnabled({
    enabled: true,
    triggerId: trigger.id,
  });
  expect(resumed.secret).toBeNull();
  expect(resumed.trigger.disabledAt).toBeNull();
});

test("setEnabled true on a proposal approves it and returns the secret", async () => {
  const { agent, caller, composed, run } = await proposalSetup();
  const { trigger } = await composed.services.triggers.create(run, {
    agentId: agent.id,
    name: "proposed",
  });

  const resumed = await caller.triggers.setEnabled({
    enabled: true,
    triggerId: trigger.id,
  });
  expect(resumed.secret?.startsWith(TRIGGER_PREFIX)).toBe(true);
  expect(resumed.trigger.approvedAt).not.toBeNull();
  expect(resumed.trigger.disabledAt).toBeNull();
});
