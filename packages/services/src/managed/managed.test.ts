import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import {
  managedAgents,
  managedRuns,
  managedSessions,
} from "@repo/db/schema/managed";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "../agents.ts";
import {
  seedAssignment,
  seedConnector,
  seedCredential,
} from "../connectors/test-seed.ts";
import { createCredentialsService } from "../credentials.ts";
import { importSecretsKey } from "../crypto.ts";
import { createEventsService } from "../events.ts";
import {
  importRunTokenKey,
  SESSION_TOKEN_PREFIX,
  verifyAgentToken,
} from "../run-tokens.ts";
import type { Clock, StartRunInput } from "../runs/types.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { advanceCursor, eventsAfter, type SessionEvent } from "./events.ts";
import type { ManagedGateway } from "./gateway.ts";
import { createManagedKeysService } from "./keys.ts";
import { createManagedRuntime } from "./runtime.ts";
import {
  BUSY_RETRY_MS,
  createManagedService,
  FAILURE_LIMIT,
  type ManagedService,
  NO_KEY_ERROR,
  POLL_MS,
} from "./service.ts";
import type { ManagedPollerPort } from "./types.ts";

const WORKSPACE = "w1";
const START = "2026-10-17T10:00:00.000Z";
const BASE = "https://hm.example";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const FAKE_API_KEY = "sk-ant-test-0000";
const SECOND = 1000;

const person = (userId: string): Principal => ({
  kind: "user",
  userId,
  via: "slack",
  workspaceId: WORKSPACE,
});
const dom = person("user_dom");
const sam = person("user_sam");

/** One Anthropic session as the fake keeps it. */
interface FakeSession {
  agentId: string;
  events: SessionEvent[];
  id: string;
  messages: string[];
  vaultIds: readonly string[];
}

/**
 * The Managed Agents API as a script. `turns` is what the session does in
 * answer to each message that reaches it (the first message creates the
 * session), played back in order.
 */
class FakeGateway implements ManagedGateway {
  agentSeq = 0;
  credentials: { token: string; url: string; vaultId: string }[] = [];
  deletedVaults: string[] = [];
  interrupted: string[] = [];
  pollFailure: Error | null = null;
  registered: { instructions: string; name: string; urls: string[] }[] = [];
  readonly sessions = new Map<string, FakeSession>();
  sessionStatus: "idle" | "running" = "idle";
  synced: string[] = [];
  turns: SessionEvent[][] = [];
  vaults: string[] = [];
  private eventSeq = 0;

  event(
    type: string,
    extra: Partial<SessionEvent> = {},
    id?: string
  ): SessionEvent {
    this.eventSeq += 1;
    return {
      id: id ?? `evt_${this.eventSeq}`,
      processedAt: new Date(Date.parse(START) + this.eventSeq).toISOString(),
      type,
      ...extra,
    };
  }

  say(text: string) {
    return this.event("agent.message", { text });
  }

  idle(stopReason = "end_turn") {
    return this.event("session.status_idle", { stopReason });
  }

  running() {
    return this.event("session.status_running");
  }

  call(name: string, input: Record<string, unknown>, id: string) {
    return this.event("agent.mcp_tool_use", { tool: { id, input, name } });
  }

  result(toolUseId: string, text: string, isError = false) {
    return this.event("agent.mcp_tool_result", {
      result: { isError, text, toolUseId },
    });
  }

  private play(session: FakeSession) {
    const turn = this.turns.shift() ?? [this.running(), this.idle()];
    session.events.push(...turn);
  }

  createBearerCredential(input: {
    mcpServerUrl: string;
    token: string;
    vaultId: string;
  }) {
    this.credentials.push({
      token: input.token,
      url: input.mcpServerUrl,
      vaultId: input.vaultId,
    });
    return Promise.resolve(`cred_${this.credentials.length}`);
  }

  createSession(input: {
    anthropicAgentId: string;
    text: string;
    vaultIds: readonly string[];
  }) {
    const session: FakeSession = {
      agentId: input.anthropicAgentId,
      events: [],
      id: `sesn_${this.sessions.size + 1}`,
      messages: [input.text],
      vaultIds: input.vaultIds,
    };
    this.sessions.set(session.id, session);
    this.play(session);
    return Promise.resolve({
      sessionId: session.id,
      status: "running" as const,
    });
  }

  createVault() {
    const id = `vlt_${this.vaults.length + 1}`;
    this.vaults.push(id);
    return Promise.resolve(id);
  }

  deleteVault(vaultId: string) {
    this.deletedVaults.push(vaultId);
    return Promise.resolve();
  }

  ensureEnvironment() {
    return Promise.resolve("env_1");
  }

  getSession() {
    return Promise.resolve(this.sessionStatus);
  }

  interrupt(sessionId: string) {
    this.interrupted.push(sessionId);
    return Promise.resolve();
  }

  pollEvents(
    sessionId: string,
    cursor: Parameters<ManagedGateway["pollEvents"]>[1]
  ) {
    if (this.pollFailure) {
      return Promise.reject(this.pollFailure);
    }
    const session = this.sessions.get(sessionId);
    const fresh = eventsAfter(session?.events ?? [], cursor);
    return Promise.resolve({
      cursor: advanceCursor(fresh, cursor),
      events: fresh,
    });
  }

  registerAgent(input: {
    instructions: string;
    mcpServers: readonly { name: string; url: string }[];
    name: string;
  }) {
    this.agentSeq += 1;
    this.registered.push({
      instructions: input.instructions,
      name: input.name,
      urls: input.mcpServers.map((server) => server.url),
    });
    return Promise.resolve({ anthropicAgentId: `agent_${this.agentSeq}` });
  }

  sendMessage(sessionId: string, text: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push(text);
      this.play(session);
    }
    return Promise.resolve();
  }

  syncAgent(input: { anthropicAgentId: string }) {
    this.synced.push(input.anthropicAgentId);
    return Promise.resolve();
  }
}

let db: ReturnType<typeof migrated>;
let nowMs: number;
let gateway: FakeGateway;
let agents: AgentsService;
let runs: RunsService;
let managed: ManagedService;
let kicks: string[];
let cancels: string[];
let agentId: string;
let tokenKey: CryptoKey;
let hasKey: boolean;
let events: ReturnType<typeof createEventsService>;
let keys: ReturnType<typeof createManagedKeysService>;

const buildManaged = (publicBaseUrl: string) =>
  createManagedService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    gatewayFor: () => gateway,
    keys: {
      rememberEnvironment: keys.rememberEnvironment,
      resolve: (workspaceId) =>
        hasKey ? keys.resolve(workspaceId) : Promise.resolve(null),
    },
    poller,
    publicBaseUrl,
    runs,
    runTokenKey: RUN_TOKEN_KEY,
  });

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const poller: ManagedPollerPort = {
  cancel: (runId) => {
    cancels.push(runId);
    return Promise.resolve();
  },
  kick: (runId) => {
    kicks.push(runId);
    return Promise.resolve();
  },
};

const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).get();

const sessionRow = (sessionId: string) =>
  db
    .select()
    .from(managedSessions)
    .where(eq(managedSessions.sessionId, sessionId))
    .get();

const runEvents = (runId: string) =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.runId, runId))
    .orderBy(asc(eventRows.id))
    .all();

const start = async (
  principal: Principal,
  text = "Reply with the word pelican",
  extra: Partial<StartRunInput> = {},
  forAgent = agentId
) => {
  nowMs += SECOND;
  return await runs.startRun(principal, {
    agentId: forAgent,
    input: { text },
    session: { externalKey: "thread-1", origin: "slack" },
    ...extra,
  });
};

/** Steps the run until it stops asking to be woken, at most `limit` times. */
const drive = async (runId: string, limit = 10) => {
  let last = await managed.step(runId);
  for (let count = 1; last.next !== null && count < limit; count += 1) {
    nowMs += POLL_MS;
    // biome-ignore lint/performance/noAwaitInLoops: each step builds on the last
    last = await managed.step(runId);
  }
  return last;
};

const tokenOf = (vaultId: string) =>
  gateway.credentials.find((credential) => credential.vaultId === vaultId)
    ?.token ?? "";

const verify = (token: string) =>
  verifyAgentToken({ db, key: tokenKey, now: clock.now(), token });

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  gateway = new FakeGateway();
  kicks = [];
  cancels = [];
  hasKey = true;
  tokenKey = await importRunTokenKey(RUN_TOKEN_KEY);
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  const store = new Map<string, string>();
  const blobs = {
    get: (name: string) => Promise.resolve(store.get(name) ?? null),
    put: (name: string, body: string) => {
      store.set(name, body);
      return Promise.resolve();
    },
  };
  events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(dom, {
      instructions: "Be brief.",
      model: "sonnet",
      name: "Pelican",
      runtime: "managed",
    })
  ).id;
  keys = createManagedKeysService({
    clock,
    db,
    secretsKey: SECRETS_KEY,
  });
  await keys.set(dom, { apiKey: FAKE_API_KEY });
  const atomic = sqliteAtomic(db);
  runs = createRunsService({
    adapters: [createManagedRuntime({ poller })],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  managed = buildManaged(BASE);
});

describe("dispatch", () => {
  test("marks the run offered and wakes its poller, without calling Anthropic", async () => {
    const { runId } = await start(dom);

    expect(runRow(runId)?.status).toBe("offered");
    expect(kicks).toEqual([runId]);
    expect(gateway.registered).toEqual([]);
    expect(gateway.vaults).toEqual([]);
  });
});

describe("a run that finishes", () => {
  test("claims, registers the agent, sends the input and completes with the reply", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running(), gateway.say("Let me look.")]];

    const first = await managed.step(runId);

    expect(first).toEqual({ next: POLL_MS });
    expect(runRow(runId)?.status).toBe("running");
    expect(runRow(runId)?.claimedBy).toBe("managed");
    expect(gateway.registered).toHaveLength(1);
    expect(gateway.registered[0]?.urls).toEqual([`${BASE}/mcp`]);
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual([
      "Reply with the word pelican",
    ]);

    gateway.sessions
      .get("sesn_1")
      ?.events.push(
        gateway.call("echo", { text: "pelican" }, "tu_1"),
        gateway.result("tu_1", "pelican"),
        gateway.say("pelican"),
        gateway.idle()
      );
    const last = await managed.step(runId);

    expect(last).toEqual({ next: null });
    const run = runRow(runId);
    expect(run?.status).toBe("done");
    expect(run?.resultText).toBe("pelican");
    const types = runEvents(runId).map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "run.queued",
        "message.user",
        "run.started",
        "message.assistant",
        "tool.call",
        "tool.result",
        "run.finished",
      ])
    );
    const call = runEvents(runId).find((event) => event.type === "tool.call");
    expect(JSON.parse(call?.payload ?? "{}")).toEqual({
      input: { text: "pelican" },
      name: "echo",
      toolUseId: "tu_1",
    });
  });

  test("the reply is what the agent said after its last tool call", async () => {
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.say("Checking."),
        gateway.call("echo", {}, "tu_1"),
        gateway.result("tu_1", "ok"),
        gateway.say("All"),
        gateway.say("done."),
        gateway.idle(),
      ],
    ];

    await drive(runId);

    expect(runRow(runId)?.resultText).toBe("All\n\ndone.");
  });

  test("a poll with no new events keeps the run going and moves its lease", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);
    const before = runRow(runId)?.leaseUntil;

    nowMs += 20 * SECOND;
    const again = await managed.step(runId);

    expect(again).toEqual({ next: POLL_MS });
    expect(runRow(runId)?.status).toBe("running");
    expect(runRow(runId)?.leaseUntil).not.toBe(before);
  });

  test("a managed run's files are named in the message, not dropped quietly", async () => {
    const { runId } = await start(dom);
    db.update(runRows)
      .set({ inputFileIds: JSON.stringify(["f1", "f2"]) })
      .where(eq(runRows.id, runId))
      .run();

    await managed.step(runId);

    const [message] = gateway.sessions.get("sesn_1")?.messages ?? [];
    expect(message).toContain("2 attached file(s) could not be passed");
  });
});

describe("a run that stops early", () => {
  test("a budget stop fails the run, closes the session and drops its vault", async () => {
    const { runId, sessionId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.say("Working"),
        gateway.idle("budget_reached"),
      ],
    ];

    await drive(runId);

    const run = runRow(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("spend limit");
    expect(sessionRow(sessionId)?.closedAt).not.toBeNull();
    expect(gateway.deletedVaults).toEqual(["vlt_1"]);
  });

  test("a terminated session fails the run", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.event("session.status_terminated")]];

    await drive(runId);

    expect(runRow(runId)?.status).toBe("failed");
  });

  test("a run with no Anthropic key fails with the way to fix it", async () => {
    hasKey = false;
    const { runId } = await start(dom);

    await managed.step(runId);

    expect(runRow(runId)?.status).toBe("failed");
    expect(runRow(runId)?.error).toBe(NO_KEY_ERROR);
    expect(gateway.registered).toEqual([]);
  });

  test("polls that keep failing fail the run without echoing the API's words", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);
    gateway.pollFailure = new Error(`boom ${FAKE_API_KEY}`);

    let answer = await managed.step(runId);
    for (let count = 1; answer.next !== null && count < 10; count += 1) {
      nowMs += 10 * SECOND;
      // biome-ignore lint/performance/noAwaitInLoops: each failure builds on the last
      answer = await managed.step(runId);
    }

    expect(answer).toEqual({ next: null });
    const run = runRow(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toStartWith("Anthropic could not be reached");
    expect(run?.error).not.toContain(FAKE_API_KEY);
    expect(
      db.select().from(managedRuns).where(eq(managedRuns.runId, runId)).get()
        ?.failures
    ).toBe(FAILURE_LIMIT);
  });

  test("cancelling stops the session and closes it", async () => {
    const { runId, sessionId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);

    await runs.cancelRun(dom, runId);
    await managed.interrupt(runId);

    expect(cancels).toEqual([runId]);
    expect(gateway.interrupted).toEqual(["sesn_1"]);
    expect(sessionRow(sessionId)?.closedAt).not.toBeNull();
    expect(await managed.step(runId)).toEqual({ next: null });
  });
});

describe("sessions", () => {
  test("a second run in the session goes into the same Anthropic session", async () => {
    const first = await start(dom, "one");
    await drive(first.runId);
    const second = await start(dom, "two");
    gateway.turns = [[gateway.running()]];

    const answer = await managed.step(second.runId);

    expect(answer).toEqual({ next: POLL_MS });
    expect(gateway.sessions.size).toBe(1);
    expect(gateway.vaults).toHaveLength(1);
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual(["one", "two"]);
    // The first run's idle is behind the cursor, so it does not end this run.
    expect(runRow(second.runId)?.status).toBe("running");
  });

  test("events nobody read, such as an interrupted run's end, do not finish the next run", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("old news"), gateway.idle());
    db.update(runRows)
      .set({ status: "interrupted" })
      .where(eq(runRows.id, first.runId))
      .run();
    const second = await start(dom, "two");
    gateway.turns = [[gateway.running()]];

    await managed.step(second.runId);

    expect(runRow(second.runId)?.status).toBe("running");
    expect(
      runEvents(second.runId).filter((e) => e.type === "message.assistant")
    ).toEqual([]);
  });

  test("a PUBLIC_BASE_URL that only this machine can reach fails the run with the fix", async () => {
    managed = buildManaged("http://localhost:3000");
    const { runId } = await start(dom);

    await managed.step(runId);

    expect(runRow(runId)?.status).toBe("failed");
    expect(runRow(runId)?.error).toContain("cloudflared tunnel");
    expect(gateway.registered).toEqual([]);
  });

  test("a changed agent updates the Anthropic agent and starts a fresh session", async () => {
    const first = await start(dom, "one");
    await drive(first.runId);
    await agents.update(dom, agentId, { instructions: "Be very brief." });
    const second = await start(dom, "two");

    await managed.step(second.runId);

    expect(gateway.synced).toEqual(["agent_1"]);
    expect(gateway.sessions.size).toBe(2);
    expect(gateway.deletedVaults).toEqual(["vlt_1"]);
    const agentRow = db.select().from(managedAgents).get();
    expect(agentRow?.anthropicAgentId).toBe("agent_1");
  });

  test("a run waits while another run of its session is running", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const second = await start(dom, "two");

    const answer = await managed.step(second.runId);

    expect(answer).toEqual({ next: BUSY_RETRY_MS });
    expect(runRow(second.runId)?.status).toBe("offered");
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual(["one"]);
  });

  test("when a run ends, the next run of its session is offered", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const second = await start(dom, "two");
    kicks = [];
    gateway.sessions.get("sesn_1")?.events.push(gateway.idle());

    await managed.step(first.runId);

    expect(runRow(first.runId)?.status).toBe("done");
    expect(kicks).toEqual([second.runId]);
  });

  test("the minute tick wakes the poller of a running run", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);
    kicks = [];

    const { kicked } = await managed.rearm();

    expect(kicked).toEqual([runId]);
    expect(kicks).toEqual([runId]);
  });
});

describe("session tokens", () => {
  test("the vault holds a session token for the platform and each connector", async () => {
    await seedConnector(db, {
      authKind: "none",
      id: "con_1",
      name: "Stub",
      now: START,
      workspaceId: WORKSPACE,
    });
    await seedAssignment(db, {
      agentId,
      connectorId: "con_1",
      now: START,
      workspaceId: WORKSPACE,
    });
    const { runId } = await start(dom);

    await managed.step(runId);

    expect(gateway.registered[0]?.urls).toEqual([
      `${BASE}/mcp`,
      `${BASE}/api/proxy/con_1`,
    ]);
    const urls = gateway.credentials.map((credential) => credential.url);
    expect(urls).toEqual([`${BASE}/mcp`, `${BASE}/api/proxy/con_1`]);
    const [token] = gateway.credentials.map((credential) => credential.token);
    expect(token?.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(new Set(gateway.credentials.map((c) => c.token)).size).toBe(1);
  });

  test("a token works only while its session has a running run", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running()]];

    await managed.step(runId);
    const token = tokenOf("vlt_1");
    const during = await verify(token);
    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("hi"), gateway.idle());
    await managed.step(runId);
    const after = await verify(token);

    expect(during).toMatchObject({ claims: { runId }, ok: true });
    expect(after).toEqual({ ok: false, reason: "not_running" });
  });

  test("a forged token and one of a closed session are refused", async () => {
    const { runId, sessionId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);
    const token = tokenOf("vlt_1");
    const forged = `${token.slice(0, -4)}AAAA`;

    expect((await verify(forged)).ok).toBe(false);
    expect((await verify(token)).ok).toBe(true);

    db.update(managedSessions)
      .set({ closedAt: START })
      .where(eq(managedSessions.sessionId, sessionId))
      .run();

    expect(await verify(token)).toEqual({ ok: false, reason: "invalid" });
  });

  test("a run token is not a session token and the reverse", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);
    const token = tokenOf("vlt_1");
    const asRun = token.replace(SESSION_TOKEN_PREFIX, "hm_run_");

    expect((await verify(asRun)).ok).toBe(false);
  });

  test("the second run, for another person, resolves that person's credential", async () => {
    const secretsKey = await importSecretsKey(SECRETS_KEY);
    await seedConnector(db, {
      authKind: "header",
      headerName: "X-Token",
      id: "con_1",
      now: START,
      workspaceId: WORKSPACE,
    });
    await seedAssignment(db, {
      agentId,
      connectorId: "con_1",
      now: START,
      workspaceId: WORKSPACE,
    });
    for (const [userId, secret] of [
      ["user_dom", "dom-secret-value"],
      ["user_sam", "sam-secret-value"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: two seeds
      await seedCredential(db, secretsKey, {
        connectorId: "con_1",
        now: START,
        ownerId: userId,
        ownerKind: "user",
        secret,
        workspaceId: WORKSPACE,
      });
    }
    const credentials = createCredentialsService({
      clock,
      db,
      fetch: () => Promise.reject(new Error("no network in this test")),
      secretsKey: SECRETS_KEY,
    });
    const headerFor = async (bearer: string) => {
      const verdict = await verify(bearer);
      if (!verdict.ok) {
        return null;
      }
      const context = await credentials.runContext(verdict.claims);
      const resolution = await credentials.resolve({
        agentId,
        connectorId: "con_1",
        onBehalfOfUserId: context?.onBehalfOfUserId ?? null,
        workspaceId: WORKSPACE,
      });
      return resolution.ok && resolution.credential
        ? resolution.credential.header.value
        : null;
    };

    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const token = tokenOf("vlt_1");
    const firstHeader = await headerFor(token);
    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("one"), gateway.idle());
    await managed.step(first.runId);

    const second = await start(sam, "two");
    gateway.turns = [[gateway.running()]];
    await managed.step(second.runId);
    const secondHeader = await headerFor(token);

    expect(first.sessionId).toBe(second.sessionId);
    expect(gateway.vaults).toHaveLength(1);
    expect(firstHeader).toBe("dom-secret-value");
    expect(secondHeader).toBe("sam-secret-value");
  });

  test("two concurrent sessions of one agent do not share a token", async () => {
    const one = await start(dom, "one", {
      session: { externalKey: "thread-a", origin: "slack" },
    });
    const two = await start(sam, "two", {
      session: { externalKey: "thread-b", origin: "slack" },
    });
    gateway.turns = [[gateway.running()], [gateway.running()]];

    await managed.step(one.runId);
    await managed.step(two.runId);

    expect(one.sessionId).not.toBe(two.sessionId);
    expect(gateway.vaults).toHaveLength(2);
    const tokenOne = tokenOf("vlt_1");
    const tokenTwo = tokenOf("vlt_2");
    expect(tokenOne).not.toBe(tokenTwo);
    expect(await verify(tokenOne)).toMatchObject({
      claims: { runId: one.runId },
      ok: true,
    });
    expect(await verify(tokenTwo)).toMatchObject({
      claims: { runId: two.runId },
      ok: true,
    });
  });
});

test("the system principal can cancel nothing it did not start", () => {
  expect(SYSTEM_PRINCIPAL.kind).toBe("system");
});
