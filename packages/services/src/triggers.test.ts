import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { isPendingProposal } from "@repo/db/shared";
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
type EventRow = typeof eventRows.$inferSelect;

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

const eventsOfType = (type: string) =>
  db.select().from(eventRows).where(eq(eventRows.type, type)).all();

/** Every `trigger.*` event, whatever its type. */
const triggerEventCount = () =>
  db
    .select()
    .from(eventRows)
    .all()
    .filter((event) => event.type.startsWith("trigger.")).length;

/** The event of one type that names this trigger in its payload. */
const eventFor = (type: string, triggerId: string): EventRow | undefined =>
  eventsOfType(type).find((event) => payloadOf(event).triggerId === triggerId);

const payloadOf = (event: EventRow | undefined): Record<string, unknown> =>
  JSON.parse(event?.payload ?? "{}") as Record<string, unknown>;

/** The secret a creation or approval handed back. Fails the test when there is none. */
const secretOf = (result: { secret: string | null }): string => {
  if (result.secret === null) {
    throw new Error("Expected a secret");
  }
  return result.secret;
};

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
  const created = await service.create(user, { agentId, name });
  return {
    principal: await authed(secretOf(created)),
    trigger: created.trigger,
  };
};

/** The principal of a run of `agentId`. */
const runAs = (agentId: string, runId: string): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
});

/** Starts a real run of the fake agent, so events can name it. */
const startFakeRun = async (): Promise<string> => {
  const started = await runs.startRun(user, {
    agentId: fakeAgentId,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  return started.runId;
};

/** A run of the fake agent proposes a trigger for it. */
const propose = async (runId: string, name = "Proposed") =>
  (
    await service.create(runAs(fakeAgentId, runId), {
      agentId: fakeAgentId,
      name,
    })
  ).trigger;

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
    clock,
    db,
    events,
    runs,
  });
});

test("create returns an ag_trg_ secret and a summary without hash fields", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "  Ping  ",
  });
  const secret = secretOf(created);
  const { trigger } = created;

  expect(secret.startsWith("ag_trg_")).toBe(true);
  expect(trigger.id.startsWith("trg_")).toBe(true);
  expect(trigger).toEqual({
    agentId: fakeAgentId,
    agentName: "Fake",
    approvedAt: null,
    createdAt: START,
    disabledAt: null,
    id: trigger.id,
    kind: "http",
    lastFiredAt: null,
    name: "Ping",
    proposedByAgentId: null,
    proposedByRunId: null,
    revokedAt: null,
    tokenPrefix: secret.slice(0, "ag_trg_".length + 4),
  });
  expect(Object.keys(trigger)).not.toContain("tokenHash");
});

test("create stores the SHA-256 of the secret, never the secret", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  const secret = secretOf(created);

  const row = triggerRow(created.trigger.id);
  expect(row?.tokenHash).toBe(await hashToken(secret));
  expect(row?.tokenHash).not.toBe(secret);
  expect(row?.createdBy).toBe("u1");
  expect(row?.workspaceId).toBe(WORKSPACE);
  expect(JSON.stringify(row)).not.toContain(secret);
});

test("create refuses Slack, machine and trigger principals, and allows an API-key user", async () => {
  const slackUser: Principal = {
    kind: "user",
    userId: "u1",
    via: "slack",
    workspaceId: WORKSPACE,
  };
  const apiKeyUser: Principal = {
    kind: "user",
    userId: "u1",
    via: "api_key",
    workspaceId: WORKSPACE,
  };
  const triggerPrincipal: Principal = {
    agentId: fakeAgentId,
    kind: "trigger",
    triggerId: "trg_other",
    workspaceId: WORKSPACE,
  };

  await expect(
    service.create(slackUser, { agentId: fakeAgentId, name: "Hook" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.create(
      { kind: "machine", machineId: "m1", workspaceId: WORKSPACE },
      { agentId: fakeAgentId, name: "Hook" }
    )
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.create(triggerPrincipal, { agentId: fakeAgentId, name: "Hook" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  const created = await service.create(apiKeyUser, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  expect(secretOf(created).startsWith("ag_trg_")).toBe(true);
});

test("a signed-in user's create is logged as the user, with the session named", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  const secret = secretOf(created);

  const row = triggerRow(created.trigger.id);
  expect(row?.tokenHash).toBe(await hashToken(secret));
  expect(row?.disabledAt).toBeNull();
  expect(row?.proposedByAgentId).toBeNull();
  expect(row?.proposedByRunId).toBeNull();

  const event = eventFor("trigger.created", created.trigger.id);
  expect(event).toMatchObject({
    actorId: "u1",
    actorKind: "user",
    agentId: fakeAgentId,
    runId: null,
  });
  expect(payloadOf(event)).toMatchObject({
    kind: "http",
    principal: { userId: "u1", via: "session" },
    proposed: false,
  });
});

test("an API-key or OAuth user with write access can create, and the log names the key or client", async () => {
  const apiKeyUser: Principal = {
    apiKey: { access: "write", id: "key1" },
    kind: "user",
    userId: "u1",
    via: "api_key",
    workspaceId: WORKSPACE,
  };
  const oauthUser: Principal = {
    kind: "user",
    oauthClient: { access: "write", clientId: "c1" },
    userId: "u1",
    via: "oauth",
    workspaceId: WORKSPACE,
  };

  const byKey = await service.create(apiKeyUser, {
    agentId: fakeAgentId,
    name: "Key",
  });
  const byClient = await service.create(oauthUser, {
    agentId: fakeAgentId,
    name: "Client",
  });

  expect(secretOf(byKey).startsWith("ag_trg_")).toBe(true);
  expect(secretOf(byClient).startsWith("ag_trg_")).toBe(true);
  expect(
    payloadOf(eventFor("trigger.created", byKey.trigger.id))
  ).toMatchObject({ principal: { keyId: "key1", via: "api_key" } });
  expect(
    payloadOf(eventFor("trigger.created", byClient.trigger.id))
  ).toMatchObject({ principal: { clientId: "c1", via: "oauth" } });
});

const readOnlyReaders: [string, Principal][] = [
  [
    "API key",
    {
      apiKey: { access: "read", id: "key2" },
      kind: "user",
      userId: "u1",
      via: "api_key",
      workspaceId: WORKSPACE,
    },
  ],
  [
    "OAuth client",
    {
      kind: "user",
      oauthClient: { access: "read", clientId: "c2" },
      userId: "u1",
      via: "oauth",
      workspaceId: WORKSPACE,
    },
  ],
];

test.each(readOnlyReaders)(
  "a read-only %s can list but not create, pause, revoke, approve or reject",
  async (_label, reader) => {
    const { trigger } = await service.create(user, {
      agentId: fakeAgentId,
      name: "Hook",
    });

    expect(await service.list(reader)).toHaveLength(1);
    await expect(
      service.create(reader, { agentId: fakeAgentId, name: "Nope" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.setEnabled(reader, { enabled: false, triggerId: trigger.id })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.revoke(reader, trigger.id)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(service.approve(reader, trigger.id)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(service.reject(reader, trigger.id)).rejects.toBeInstanceOf(
      ForbiddenError
    );

    expect(triggerRow(trigger.id)?.revokedAt).toBeNull();
    expect(triggerRow(trigger.id)?.disabledAt).toBeNull();
  }
);

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
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });

  expect(await service.authenticate(`Bearer ${secretOf(created)}`)).toEqual({
    agentId: fakeAgentId,
    kind: "trigger",
    triggerId: created.trigger.id,
    workspaceId: WORKSPACE,
  });
});

test("authenticate gives null for a revoked trigger", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  await service.revoke(user, created.trigger.id);

  expect(await service.authenticate(`Bearer ${secretOf(created)}`)).toBeNull();
});

test("authenticate gives null for an unknown token, a wrong prefix, or no header", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  const wrongPrefix = `hm_key_${secretOf(created).slice("ag_trg_".length)}`;

  expect(await service.authenticate("Bearer hm_trg_unknownsecret")).toBeNull();
  expect(await service.authenticate(`Bearer ${wrongPrefix}`)).toBeNull();
  expect(await service.authenticate(null)).toBeNull();
});

test("authenticate takes a token from before the rename, hm_trg_", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  const legacy = `hm_trg_${secretOf(created).slice("ag_trg_".length)}`;
  db.update(triggerRows)
    .set({ tokenHash: await hashToken(legacy) })
    .where(eq(triggerRows.id, created.trigger.id))
    .run();

  expect(await service.authenticate(`Bearer ${legacy}`)).toMatchObject({
    kind: "trigger",
    triggerId: created.trigger.id,
  });
});

test("authenticate gives null when the trigger's workspace has no row", async () => {
  const created = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  // D1's foreign keys would refuse this delete. A row that is gone while its
  // trigger remains is the case this guards.
  db.client.run("PRAGMA foreign_keys = OFF");
  db.delete(workspaceRows).where(eq(workspaceRows.id, WORKSPACE)).run();

  expect(await service.authenticate(`Bearer ${secretOf(created)}`)).toBeNull();
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

test("a run's create is a tokenless proposal, paused and logged as the agent", async () => {
  const runId = await startFakeRun();

  const created = await service.create(runAs(fakeAgentId, runId), {
    agentId: fakeAgentId,
    name: "Proposed",
  });

  expect(created.secret).toBeNull();
  expect(JSON.stringify(created)).not.toContain("ag_trg_");
  expect(created.trigger).toMatchObject({
    approvedAt: null,
    disabledAt: new Date(nowMs).toISOString(),
    proposedByAgentId: fakeAgentId,
    proposedByRunId: runId,
  });
  const row = triggerRow(created.trigger.id);
  expect(row).toMatchObject({
    approvedAt: null,
    disabledAt: new Date(nowMs).toISOString(),
    proposedByAgentId: fakeAgentId,
    proposedByRunId: runId,
    tokenHash: null,
    tokenPrefix: null,
  });
  expect(JSON.stringify(row)).not.toContain("ag_trg_");
  expect(await service.authenticate("Bearer hm_trg_anything")).toBeNull();

  const event = eventFor("trigger.created", created.trigger.id);
  expect(event).toMatchObject({
    actorId: fakeAgentId,
    actorKind: "agent",
    agentId: fakeAgentId,
    runId,
  });
  expect(payloadOf(event)).toMatchObject({
    principal: { agentId: fakeAgentId, runId, via: "run" },
    proposed: true,
  });
});

test("a run cannot propose a trigger for another agent", async () => {
  const runId = await startFakeRun();

  await expect(
    service.create(runAs(fakeAgentId, runId), {
      agentId: spyAgentId,
      name: "Other",
    })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("a run may pause its own agent's triggers, never resume them, and revoke only its own proposals", async () => {
  const runId = await startFakeRun();
  const runner = runAs(fakeAgentId, runId);
  const proposal = await propose(runId);
  const made = (
    await service.create(user, { agentId: fakeAgentId, name: "Made" })
  ).trigger;
  const elsewhere = (
    await service.create(user, { agentId: spyAgentId, name: "Elsewhere" })
  ).trigger;

  await expect(
    service.setEnabled(runner, { enabled: true, triggerId: proposal.id })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.setEnabled(runner, { enabled: true, triggerId: made.id })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    service.setEnabled(runner, { enabled: false, triggerId: elsewhere.id })
  ).rejects.toBeInstanceOf(ForbiddenError);

  const paused = await service.setEnabled(runner, {
    enabled: false,
    triggerId: made.id,
  });
  expect(paused.secret).toBeNull();
  expect(paused.trigger.disabledAt).toBe(new Date(nowMs).toISOString());

  const revoked = await service.revoke(runner, proposal.id);
  expect(revoked.revokedAt).toBe(new Date(nowMs).toISOString());
  expect(eventFor("trigger.deleted", proposal.id)).toMatchObject({
    actorId: fakeAgentId,
    actorKind: "agent",
    runId,
  });
  await expect(service.revoke(runner, made.id)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  expect(triggerRow(made.id)?.revokedAt).toBeNull();

  const listed = await service.list(runner);
  expect(listed.map((trigger) => trigger.id).sort()).toEqual(
    [proposal.id, made.id].sort()
  );
  await expect(
    service.list(runner, { agentId: spyAgentId })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("approving a proposal mints its one token, shows it once, and the token fires the trigger", async () => {
  const runId = await startFakeRun();
  const proposal = await propose(runId);

  const approved = await service.approve(user, proposal.id);
  const secret = secretOf(approved);
  const hint = secret.slice(0, "ag_trg_".length + 4);

  expect(secret.startsWith("ag_trg_")).toBe(true);
  expect(approved.trigger).toMatchObject({
    approvedAt: new Date(nowMs).toISOString(),
    disabledAt: null,
    tokenPrefix: hint,
  });
  expect(triggerRow(proposal.id)).toMatchObject({
    approvedAt: new Date(nowMs).toISOString(),
    disabledAt: null,
    tokenHash: await hashToken(secret),
    tokenPrefix: hint,
  });
  expect(eventFor("trigger.approved", proposal.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
  });
  expect(JSON.stringify(db.select().from(eventRows).all())).not.toContain(
    secret
  );

  const result = await service.fire(await authed(secret), proposal.id, {
    text: "ping",
    waitMs: 5000,
  });
  expect(result.finished).toBe(true);
  expect(result.run).toMatchObject({
    resultText: "Echo: ping",
    status: "done",
  });
});

test("approve refuses a run, a trigger a user made, and a second approval", async () => {
  const runId = await startFakeRun();
  const proposal = await propose(runId);
  const made = (
    await service.create(user, { agentId: fakeAgentId, name: "Made" })
  ).trigger;

  await expect(
    service.approve(runAs(fakeAgentId, runId), proposal.id)
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(service.approve(user, made.id)).rejects.toMatchObject({
    code: "conflict",
  });

  const first = await service.approve(user, proposal.id);
  const hashAfterFirst = triggerRow(proposal.id)?.tokenHash;
  await expect(service.approve(user, proposal.id)).rejects.toMatchObject({
    code: "conflict",
  });

  expect(triggerRow(proposal.id)?.tokenHash).toBe(hashAfterFirst);
  expect(hashAfterFirst).toBe(await hashToken(secretOf(first)));
  expect(eventsOfType("trigger.approved")).toHaveLength(1);
});

test("setEnabled on a proposal approves it, and pausing and resuming keep the same token", async () => {
  const runId = await startFakeRun();
  const proposal = await propose(runId);

  const approved = await service.setEnabled(user, {
    enabled: true,
    triggerId: proposal.id,
  });
  const secret = secretOf(approved);
  const row = triggerRow(proposal.id);
  expect(row?.tokenHash).toBe(await hashToken(secret));
  expect(row && isPendingProposal(row)).toBe(false);

  const principal = await authed(secret);
  const eventsBefore = triggerEventCount();

  const paused = await service.setEnabled(user, {
    enabled: false,
    triggerId: proposal.id,
  });
  expect(paused.secret).toBeNull();
  expect(paused.trigger.disabledAt).toBe(new Date(nowMs).toISOString());
  expect(await service.authenticate(`Bearer ${secret}`)).toBeNull();
  await expect(
    service.fire(principal, proposal.id, { text: "ping" })
  ).rejects.toBeInstanceOf(ForbiddenError);

  const resumed = await service.setEnabled(user, {
    enabled: true,
    triggerId: proposal.id,
  });
  expect(resumed.secret).toBeNull();
  expect(resumed.trigger.disabledAt).toBeNull();
  expect(await authed(secret)).toMatchObject({ triggerId: proposal.id });
  expect(triggerEventCount()).toBe(eventsBefore);
});

test("reject revokes a proposal and logs it, and refuses a trigger a user made", async () => {
  const runId = await startFakeRun();
  const proposal = await propose(runId);
  const made = (
    await service.create(user, { agentId: fakeAgentId, name: "Made" })
  ).trigger;

  await expect(service.reject(user, made.id)).rejects.toMatchObject({
    code: "conflict",
  });

  const rejected = await service.reject(user, proposal.id);
  expect(rejected.revokedAt).toBe(new Date(nowMs).toISOString());
  expect(eventFor("trigger.rejected", proposal.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
  });
  expect(triggerRow(proposal.id)?.approvedAt).toBeNull();
});

test("a user's revoke of a pending proposal logs trigger.deleted, and a second revoke adds no event", async () => {
  const runId = await startFakeRun();
  const proposal = await propose(runId);

  const first = await service.revoke(user, proposal.id);
  expect(eventFor("trigger.deleted", proposal.id)).toMatchObject({
    actorId: "u1",
    actorKind: "user",
  });

  advance(MINUTE_MS);
  const second = await service.revoke(user, proposal.id);
  expect(second.revokedAt).toBe(first.revokedAt);
  expect(eventsOfType("trigger.deleted")).toHaveLength(1);
});

test("setEnabled on a revoked trigger gives not_found", async () => {
  const { trigger } = await service.create(user, {
    agentId: fakeAgentId,
    name: "Hook",
  });
  await service.revoke(user, trigger.id);

  const error = await service
    .setEnabled(user, { enabled: false, triggerId: trigger.id })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code: "not_found" });
});
