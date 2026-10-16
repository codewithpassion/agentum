import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import {
  type Blobs,
  createEventsService,
  type EventsService,
} from "./events.ts";
import type { Clock, RuntimeAdapter } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import {
  createTriggersService,
  type TriggerPrincipal,
  type TriggersService,
} from "./triggers.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const MINUTE_MS = 60 * 1000;

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const outsider: Principal = {
  kind: "user",
  userId: "u9",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let clock: Clock;
let blobs: Blobs;
let dispatched: string[];
let spy: RuntimeAdapter;
let events: EventsService;
let agents: AgentsService;
let runs: RunsService;
let service: TriggersService;
let fakeAgentId: string;
let spyAgentId: string;

const advance = (ms: number) => {
  nowMs += ms;
};

/** A runtime that only records the runs it was offered, so they never finish. */
const spyAdapter = (): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: (_db, run) => {
    dispatched.push(run.id);
    return Promise.resolve();
  },
  kind: "machine",
});

const insertWorkspace = (id: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const triggerRow = (triggerId: string) =>
  db.select().from(triggerRows).where(eq(triggerRows.id, triggerId)).get();

const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const runRowCount = () => db.select().from(runRows).all().length;

const firedEvents = (runId: string) =>
  db
    .select()
    .from(eventRows)
    .where(and(eq(eventRows.runId, runId), eq(eventRows.type, "trigger.fired")))
    .all();

/** The bearer principal a secret resolves to. Fails the test if it does not resolve. */
const authed = async (secret: string): Promise<TriggerPrincipal> => {
  const principal = await service.authenticate(`Bearer ${secret}`);
  if (!principal) {
    throw new Error("Expected the secret to authenticate");
  }
  return principal;
};

/** Creates a trigger for `agentId` and resolves its secret to a principal. */
const makeTrigger = async (agentId: string, name = "Hook") => {
  const { secret, trigger } = await service.create(user, { agentId, name });
  return { principal: await authed(secret), secret, trigger };
};

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: (ms) => {
      advance(ms);
      return Promise.resolve();
    },
  };
  dispatched = [];
  spy = spyAdapter();
  const store = new Map<string, string>();
  blobs = {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, body) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  insertWorkspace(WORKSPACE);
  insertWorkspace(OTHER_WORKSPACE);
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
      workspaceId: WORKSPACE,
    })
    .run();
  spyAgentId = (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Spy",
      runtime: "machine",
    })
  ).id;
  fakeAgentId = (
    await agents.create(user, { model: "m", name: "Fake", runtime: "fake" })
  ).id;
  runs = createRunsService({
    adapters: [spy],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
  });
  service = createTriggersService({
    allowedOrgIds: [`org_${WORKSPACE}`, `org_${OTHER_WORKSPACE}`],
    clock,
    db,
    events,
    runs,
  });
});

test("create returns an hm_trg_ secret and a summary without hash fields", async () => {
  const { secret, trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "  Ping  ",
  });

  expect(secret.startsWith("hm_trg_")).toBe(true);
  expect(trigger.id.startsWith("trg_")).toBe(true);
  expect(trigger).toEqual({
    agentId: fakeAgentId,
    agentName: "Fake",
    createdAt: START,
    id: trigger.id,
    kind: "http",
    lastFiredAt: null,
    name: "Ping",
    revokedAt: null,
    tokenPrefix: secret.slice(0, "hm_trg_".length + 4),
  });
  expect(Object.keys(trigger)).not.toContain("tokenHash");
});

test("create stores the SHA-256 of the secret, never the secret", async () => {
  const { secret, trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });

  const row = triggerRow(trigger.id);
  expect(row?.tokenHash).toBe(await hashToken(secret));
  expect(row?.tokenHash).not.toBe(secret);
  expect(row?.createdBy).toBe("u1");
  expect(row?.workspaceId).toBe(WORKSPACE);
  expect(JSON.stringify(row)).not.toContain(secret);
});

test("create refuses a principal that is not a signed-in user", async () => {
  const apiKeyUser: Principal = { ...user, via: "api_key" };

  await expect(
    service.create(apiKeyUser, { agentId: fakeAgentId, name: "Hook" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.create(
      { kind: "machine", machineId: "m1", workspaceId: WORKSPACE },
      { agentId: fakeAgentId, name: "Hook" }
    )
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("create gives not_found for an agent in another workspace", async () => {
  const otherAgent = await agents.create(outsider, {
    model: "m",
    name: "Elsewhere",
    runtime: "fake",
  });

  await expect(
    service.create(user, { agentId: otherAgent.id, name: "Hook" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("create gives not_found for an archived agent", async () => {
  await agents.archive(user, fakeAgentId);

  const error = await service
    .create(user, { agentId: fakeAgentId, name: "Hook" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "not_found" });
});

test("create rejects an empty name and an 81-character name", async () => {
  await expect(
    service.create(user, { agentId: fakeAgentId, name: "" })
  ).rejects.toBeInstanceOf(ZodError);
  await expect(
    service.create(user, { agentId: fakeAgentId, name: "n".repeat(81) })
  ).rejects.toBeInstanceOf(ZodError);
});

test("list returns only the caller's workspace, newest first, with the agent name", async () => {
  const first = await service.create(user, {
    agentId: fakeAgentId,
    name: "first",
  });
  advance(MINUTE_MS);
  const second = await service.create(user, {
    agentId: spyAgentId,
    name: "second",
  });
  advance(MINUTE_MS);
  const otherAgent = await agents.create(outsider, {
    model: "m",
    name: "Elsewhere",
    runtime: "fake",
  });
  await service.create(outsider, { agentId: otherAgent.id, name: "theirs" });

  const triggers = await service.list(user);

  expect(triggers.map((trigger) => trigger.name)).toEqual(["second", "first"]);
  expect(triggers[0]?.id).toBe(second.trigger.id);
  expect(triggers[0]?.agentName).toBe("Spy");
  expect(triggers[1]?.id).toBe(first.trigger.id);
  expect(triggers[1]?.agentName).toBe("Fake");
  expect(Object.keys(triggers[0] ?? {})).not.toContain("tokenHash");
});

test("list filters by agent and includes revoked triggers", async () => {
  const fake = await service.create(user, {
    agentId: fakeAgentId,
    name: "fake",
  });
  await service.create(user, { agentId: spyAgentId, name: "spy" });
  await service.revoke(user, fake.trigger.id);

  const triggers = await service.list(user, { agentId: fakeAgentId });

  expect(triggers.map((trigger) => trigger.name)).toEqual(["fake"]);
  expect(triggers[0]?.revokedAt).toBe(new Date(nowMs).toISOString());
});

test("list refuses a principal that is not a signed-in user", async () => {
  await expect(service.list({ kind: "system" }, {})).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("revoke sets revokedAt, and a second revoke keeps the first timestamp", async () => {
  const { trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });

  const first = await service.revoke(user, trigger.id);
  expect(first.revokedAt).toBe(new Date(nowMs).toISOString());

  advance(MINUTE_MS);
  const second = await service.revoke(user, trigger.id);
  expect(second.revokedAt).toBe(first.revokedAt);
  expect(triggerRow(trigger.id)?.revokedAt).toBe(first.revokedAt);
});

test("revoke gives not_found for another workspace's trigger", async () => {
  const { trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });

  await expect(service.revoke(outsider, trigger.id)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(triggerRow(trigger.id)?.revokedAt).toBeNull();
});

test("authenticate maps a valid secret to the trigger principal", async () => {
  const { secret, trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });

  expect(await service.authenticate(`Bearer ${secret}`)).toEqual({
    agentId: fakeAgentId,
    kind: "trigger",
    triggerId: trigger.id,
    workspaceId: WORKSPACE,
  });
});

test("authenticate gives null for a revoked trigger", async () => {
  const { secret, trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  await service.revoke(user, trigger.id);

  expect(await service.authenticate(`Bearer ${secret}`)).toBeNull();
});

test("authenticate gives null for an unknown token, a wrong prefix, or no header", async () => {
  const { secret } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  const wrongPrefix = `hm_key_${secret.slice("hm_trg_".length)}`;

  expect(await service.authenticate("Bearer hm_trg_unknownsecret")).toBeNull();
  expect(await service.authenticate(`Bearer ${wrongPrefix}`)).toBeNull();
  expect(await service.authenticate(null)).toBeNull();
});

test("authenticate gives null when the workspace's org is not allowed", async () => {
  const { secret } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  const onlyOther = createTriggersService({
    allowedOrgIds: [`org_${OTHER_WORKSPACE}`],
    clock,
    db,
    events,
    runs,
  });

  expect(await onlyOther.authenticate(`Bearer ${secret}`)).toBeNull();
});

test("fire with waitMs returns the finished echo run", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);

  const result = await service.fire(principal, trigger.id, {
    text: "ping",
    waitMs: 5000,
  });

  expect(result.finished).toBe(true);
  expect(result.run).toMatchObject({
    resultText: "Echo: ping",
    status: "done",
  });
});

test("fire without waitMs returns at once with finished false", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);

  const result = await service.fire(principal, trigger.id, { text: "ping" });

  expect(result.finished).toBe(false);
  expect(result.run.id).toBeDefined();
});

test("fire records the run as the trigger, on behalf of nobody, with a trigger session", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);

  const { run } = await service.fire(principal, trigger.id, {
    text: "ping",
    waitMs: 5000,
  });

  const row = runRow(run.id);
  expect(row).toMatchObject({
    actorId: trigger.id,
    actorKind: "trigger",
    onBehalfOfUserId: null,
  });
  const session = db
    .select()
    .from(sessionRows)
    .where(eq(sessionRows.id, row?.sessionId ?? ""))
    .get();
  expect(session?.origin).toBe("trigger");
});

test("a replayed requestId returns the same run and announces it once", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);
  const input = { requestId: "req-1", text: "ping", waitMs: 5000 };

  const first = await service.fire(principal, trigger.id, input);
  const second = await service.fire(principal, trigger.id, input);

  expect(second.run.id).toBe(first.run.id);
  expect(runRowCount()).toBe(1);
  expect(firedEvents(first.run.id)).toHaveLength(1);
});

test("the same requestId on two triggers gives two runs", async () => {
  const one = await makeTrigger(fakeAgentId, "one");
  const two = await makeTrigger(fakeAgentId, "two");

  const a = await service.fire(one.principal, one.trigger.id, {
    requestId: "shared",
    text: "ping",
  });
  const b = await service.fire(two.principal, two.trigger.id, {
    requestId: "shared",
    text: "ping",
  });

  expect(b.run.id).not.toBe(a.run.id);
  expect(runRowCount()).toBe(2);
});

test("fire writes one trigger.fired event and sets lastFiredAt", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);
  advance(MINUTE_MS);

  const { run } = await service.fire(principal, trigger.id, {
    requestId: "req-2",
    text: "ping",
    waitMs: 5000,
  });

  const [event] = firedEvents(run.id);
  expect(event?.actorId).toBe(trigger.id);
  expect(JSON.parse(event?.payload ?? "null")).toEqual({
    requestId: "req-2",
    triggerId: trigger.id,
  });
  expect(triggerRow(trigger.id)?.lastFiredAt).toBe(
    new Date(nowMs).toISOString()
  );
});

test("fire refuses a token used on another trigger", async () => {
  const mine = await makeTrigger(fakeAgentId, "mine");
  const theirs = await makeTrigger(fakeAgentId, "theirs");

  await expect(
    service.fire(mine.principal, theirs.trigger.id, { text: "ping" })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("fire refuses a trigger revoked after the token was checked", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);
  await service.revoke(user, trigger.id);

  await expect(
    service.fire(principal, trigger.id, { text: "ping" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(runRowCount()).toBe(0);
});

test("fire rejects invalid input with a ZodError", async () => {
  const { principal, trigger } = await makeTrigger(fakeAgentId);
  const unknownKey = { extra: true, text: "ping" };

  await expect(
    service.fire(principal, trigger.id, { text: "" })
  ).rejects.toBeInstanceOf(ZodError);
  await expect(
    service.fire(principal, trigger.id, { text: "ping", waitMs: 120_001 })
  ).rejects.toBeInstanceOf(ZodError);
  await expect(
    service.fire(principal, trigger.id, unknownKey)
  ).rejects.toBeInstanceOf(ZodError);
  await expect(
    service.fire(principal, trigger.id, {
      requestId: "r".repeat(129),
      text: "ping",
    })
  ).rejects.toBeInstanceOf(ZodError);
  expect(runRowCount()).toBe(0);
});

test("fire with waitMs gives finished false when the run does not end in time", async () => {
  const { principal, trigger } = await makeTrigger(spyAgentId);

  const result = await service.fire(principal, trigger.id, {
    text: "ping",
    waitMs: 5000,
  });

  expect(result.finished).toBe(false);
  expect(result.run.status).toBe("queued");
  expect(dispatched).toEqual([result.run.id]);
});
