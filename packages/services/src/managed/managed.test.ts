import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import {
  managedAgents,
  managedRuns,
  managedSessions,
  managedSkills,
  managedSkillVersions,
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
import { RELAY_TOKEN_ENV } from "../secrets/relay.ts";
import { createSecretsService, type SecretsService } from "../secrets.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { advanceCursor, eventsAfter, type SessionEvent } from "./events.ts";
import type { ManagedGateway, SkillRef, SkillUploadFile } from "./gateway.ts";
import { createManagedKeysService, NO_KEY_MESSAGE } from "./keys.ts";
import { createManagedRuntime } from "./runtime.ts";
import {
  BUSY_RETRY_MS,
  createManagedService,
  FAILURE_LIMIT,
  type ManagedService,
  POLL_MS,
} from "./service.ts";
import { MANAGED_LEASE_MS, type ManagedPollerPort } from "./types.ts";

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
  /** Environment variable credentials. `value` is kept for checks, never printed. */
  envCredentials: {
    hosts: readonly string[] | undefined;
    name: string;
    value: string;
    vaultId: string;
  }[] = [];
  deletedVaults: string[] = [];
  interrupted: string[] = [];
  /** Runs when a session's status is read, to put a write between two steps of a launch. */
  onGetSession: (() => void) | null = null;
  pollFailure: Error | null = null;
  registered: {
    instructions: string;
    name: string;
    skills: readonly SkillRef[];
    system: string;
    urls: string[];
  }[] = [];
  /** Every skill the fake holds: its versions, each with the files it was uploaded with. */
  readonly skillStore = new Map<
    string,
    { files: readonly SkillUploadFile[]; version: string }[]
  >();
  deletedSkills: string[] = [];
  readonly sessions = new Map<string, FakeSession>();
  sessionStatus: "idle" | "running" = "idle";
  synced: string[] = [];
  syncedAgents: { skills: readonly SkillRef[]; system: string }[] = [];
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

  createEnvironmentVariableCredential(input: {
    hosts?: readonly string[];
    name: string;
    value: string;
    vaultId: string;
  }) {
    this.envCredentials.push({
      hosts: input.hosts,
      name: input.name,
      value: input.value,
      vaultId: input.vaultId,
    });
    return Promise.resolve(`envcred_${this.envCredentials.length}`);
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
    this.onGetSession?.();
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

  createSkill(input: { files: readonly SkillUploadFile[] }) {
    const skillId = `skill_${this.skillStore.size + 1}`;
    this.skillStore.set(skillId, [{ files: input.files, version: "1" }]);
    return Promise.resolve({ skillId, version: "1" });
  }

  createSkillVersion(input: {
    files: readonly SkillUploadFile[];
    skillId: string;
  }) {
    const versions = this.skillStore.get(input.skillId) ?? [];
    const version = String(versions.length + 1);
    versions.push({ files: input.files, version });
    this.skillStore.set(input.skillId, versions);
    return Promise.resolve(version);
  }

  deleteSkill(skillId: string) {
    this.skillStore.delete(skillId);
    this.deletedSkills.push(skillId);
    return Promise.resolve();
  }

  registerAgent(input: {
    instructions: string;
    mcpServers: readonly { name: string; url: string }[];
    name: string;
    skills: readonly SkillRef[];
    system: string;
  }) {
    this.agentSeq += 1;
    this.registered.push({
      instructions: input.instructions,
      name: input.name,
      skills: input.skills,
      system: input.system,
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

  syncAgent(input: {
    anthropicAgentId: string;
    skills: readonly SkillRef[];
    system: string;
  }) {
    this.synced.push(input.anthropicAgentId);
    this.syncedAgents.push({ skills: input.skills, system: input.system });
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
/** Runs when the runtime reads the key, to put a write between two steps of a stop. */
let onResolveKey: (() => void) | null;
let events: ReturnType<typeof createEventsService>;
let keys: ReturnType<typeof createManagedKeysService>;
let secrets: SecretsService;
/** A skill the agent carries, resolved to one version by the central store. */
interface CarriedSkill {
  files: Record<string, string>;
  name: string;
  skillId: string;
  version: number;
}

/** What the agent carries now. */
let carried: CarriedSkill[];
/** The files of every version ever carried, by `<skill id>@<version>`. */
let versionFiles: Map<string, Record<string, string>>;
/** The versions the managed service asked the source for, in order. */
let fetchedVersions: string[];

const skillsSource = () => ({
  files: (skillId: string, version: number) => {
    fetchedVersions.push(`${skillId}@${version}`);
    const files = versionFiles.get(`${skillId}@${version}`) ?? {};
    return Promise.resolve(
      Object.entries(files).map(([path, text]) => ({
        content: new TextEncoder().encode(text),
        path,
      }))
    );
  },
  list: () =>
    Promise.resolve(
      [...carried]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((skill) => ({
          files: Object.entries(skill.files).map(([path, text]) => ({
            executable: false,
            hash: `hash-${text}`,
            path,
            size: text.length,
          })),
          name: skill.name,
          pinned: false,
          skillId: skill.skillId,
          version: skill.version,
        }))
    ),
});

const buildManaged = (publicBaseUrl: string) =>
  createManagedService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    gatewayFor: () => gateway,
    keys: {
      rememberEnvironment: keys.rememberEnvironment,
      resolve: (workspaceId) => {
        onResolveKey?.();
        return hasKey ? keys.resolve(workspaceId) : Promise.resolve(null);
      },
    },
    poller,
    publicBaseUrl,
    runs,
    runTokenKey: RUN_TOKEN_KEY,
    secrets,
    skills: skillsSource,
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
  onResolveKey = null;
  carried = [];
  versionFiles = new Map();
  fetchedVersions = [];
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
  secrets = createSecretsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    secretsKey: SECRETS_KEY,
  });
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
    atomic: sqliteAtomic(db),
    clock,
    db,
    secretsKey: SECRETS_KEY,
  });
  await keys.set(dom, { apiKey: FAKE_API_KEY });
  const atomic = sqliteAtomic(db);
  runs = createRunsService({
    adapters: [
      createManagedRuntime({ abandon: (run) => managed.abandon(run), poller }),
    ],
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
    expect(runRow(runId)?.error).toBe(NO_KEY_MESSAGE);
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
    expect(sessionRow(run?.sessionId ?? "")?.closedAt).not.toBeNull();
    expect(gateway.interrupted).toEqual(["sesn_1"]);
    expect(
      db.select().from(managedRuns).where(eq(managedRuns.runId, runId)).get()
        ?.failures
    ).toBe(FAILURE_LIMIT);
  });

  test("an idle that waits on an approval fails the run, since nothing answers it", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running(), gateway.idle("requires_action")]];

    await drive(runId);

    expect(runRow(runId)?.status).toBe("failed");
    expect(runRow(runId)?.error).toContain("requires_action");
  });

  test("cancelling a run that never reached the session leaves the running run's session alone", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const second = await start(dom, "two");

    await runs.cancelRun(dom, second.runId);
    await managed.interrupt(second.runId);

    expect(gateway.interrupted).toEqual([]);
    expect(gateway.deletedVaults).toEqual([]);
    expect(sessionRow(first.sessionId)?.closedAt).toBeNull();
    expect((await verify(tokenOf("vlt_1"))).ok).toBe(true);
  });

  test("a cancel that lands while the next run takes the session over leaves the session alone", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    await runs.cancelRun(dom, first.runId);
    const second = await start(dom, "two");
    // The next run's launch points the session at itself between the cancel's
    // read of the session and its close.
    onResolveKey = () => {
      db.update(managedSessions)
        .set({ currentRunId: second.runId })
        .where(eq(managedSessions.sessionId, first.sessionId))
        .run();
    };

    await managed.interrupt(first.runId);

    expect(sessionRow(first.sessionId)?.closedAt).toBeNull();
    expect(gateway.interrupted).toEqual([]);
    expect(gateway.deletedVaults).toEqual([]);
  });

  test("a session closed by a cancel while the next run launches is replaced, not reused", async () => {
    const first = await start(dom, "one");
    await drive(first.runId);
    const second = await start(dom, "two");
    gateway.turns = [[gateway.running()]];
    gateway.onGetSession = () => {
      db.update(managedSessions)
        .set({ closedAt: START })
        .where(eq(managedSessions.sessionId, first.sessionId))
        .run();
    };

    await managed.step(second.runId);

    expect(gateway.sessions.size).toBe(2);
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual(["one"]);
    expect(gateway.sessions.get("sesn_2")?.messages).toEqual(["two"]);
    expect(sessionRow(first.sessionId)?.closedAt).toBeNull();
    expect((await verify(tokenOf("vlt_2"))).ok).toBe(true);
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

  test("a run the reaper interrupted leaves a session whose old events do not finish the next run", async () => {
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

  test("a run that is only claimed does not inherit the token of an older run's lingering session", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const token = tokenOf("vlt_1");
    db.update(runRows)
      .set({ status: "interrupted" })
      .where(eq(runRows.id, first.runId))
      .run();
    const second = await start(sam, "two");
    // Claimed, not yet launched: the session still serves the first run.
    db.update(runRows)
      .set({
        claimedBy: "managed",
        leaseUntil: new Date(nowMs + 60 * SECOND).toISOString(),
        status: "running",
      })
      .where(eq(runRows.id, second.runId))
      .run();

    expect((await verify(token)).ok).toBe(false);

    gateway.turns = [[gateway.running()]];
    await managed.step(second.runId);

    expect(await verify(token)).toMatchObject({
      claims: { runId: second.runId },
      ok: true,
    });
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
    // Waiting must not disturb the session that is working.
    expect(gateway.interrupted).toEqual([]);
    expect(gateway.deletedVaults).toEqual([]);
    expect((await verify(tokenOf("vlt_1"))).ok).toBe(true);
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

  test("a token of a replaced session is refused", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const oldToken = tokenOf("vlt_1");
    await agents.update(dom, agentId, { instructions: "Different now." });
    gateway.sessions.get("sesn_1")?.events.push(gateway.idle());
    await managed.step(first.runId);
    nowMs += SECOND;
    const second = await start(dom, "two");
    gateway.turns = [[gateway.running()]];

    await managed.step(second.runId);

    const newToken = tokenOf("vlt_2");
    expect(newToken).not.toBe(oldToken);
    expect(await verify(oldToken)).toEqual({ ok: false, reason: "invalid" });
    expect((await verify(newToken)).ok).toBe(true);
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

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: Says hello.\n---\n\n# ${name}\n`;

/** The agent carries `name` at `version`, as the store would resolve it: a new approved version, or a pin. */
const carry = (
  name: string,
  version = 1,
  script = "console.log('hi')"
): CarriedSkill => {
  const skill: CarriedSkill = {
    files: { "SKILL.md": SKILL_MD(name), "scripts/hello.ts": script },
    name,
    skillId: `hm_${name}`,
    version,
  };
  versionFiles.set(`${skill.skillId}@${version}`, skill.files);
  carried = [...carried.filter((other) => other.name !== name), skill];
  return skill;
};

/** Runs one complete run on the agent, in the same session as the last. */
const finishRun = async (text = "go") => {
  const { runId } = await start(dom, text);
  await drive(runId);
  return runId;
};

const versionRows = () => db.select().from(managedSkillVersions).all();

describe("skills", () => {
  test("an agent without skills registers none and gets no skills guidance", async () => {
    await finishRun();

    expect(gateway.registered[0]?.skills).toEqual([]);
    expect(gateway.registered[0]?.system).toBe("Be brief.");
    expect(gateway.skillStore.size).toBe(0);
  });

  test("uploads each skill version with every file and lists it on the agent, with the bun guidance", async () => {
    carry("ts-hello").files["notes/a.md"] = "# notes";

    await finishRun();

    const [upload] = [...gateway.skillStore.values()];
    expect(upload?.[0]?.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "notes/a.md",
      "scripts/hello.ts",
    ]);
    expect(gateway.registered[0]?.skills).toEqual([
      { skillId: "skill_1", version: "1" },
    ]);
    expect(gateway.registered[0]?.system).toContain(
      "bun /workspace/skills/<name>/scripts/<script>.ts"
    );
    expect(gateway.registered[0]?.system).toContain("ts-hello");
    expect(versionRows()).toMatchObject([
      {
        anthropicSkillId: "skill_1",
        anthropicVersion: "1",
        skillId: "hm_ts-hello",
        version: 1,
      },
    ]);
  });

  test("an unchanged version is not uploaded again and the agent is not synced", async () => {
    carry("ts-hello");
    await finishRun();

    await finishRun("again");

    expect(gateway.skillStore.get("skill_1")).toHaveLength(1);
    expect(fetchedVersions).toEqual(["hm_ts-hello@1"]);
    expect(gateway.synced).toEqual([]);
  });

  test("a new approved version is a new version of the same Anthropic skill, and the agent lists it", async () => {
    carry("ts-hello");
    await finishRun();
    carry("ts-hello", 2, "console.log('changed')");

    await finishRun("again");

    expect(gateway.skillStore.get("skill_1")).toHaveLength(2);
    expect(gateway.syncedAgents.at(-1)?.skills).toEqual([
      { skillId: "skill_1", version: "2" },
    ]);
    expect(
      versionRows().map((row) => [row.version, row.anthropicVersion])
    ).toEqual([
      [1, "1"],
      [2, "2"],
    ]);
  });

  test("a pin back to an uploaded version reuses that upload", async () => {
    carry("ts-hello");
    await finishRun();
    carry("ts-hello", 2, "console.log('changed')");
    await finishRun("again");

    carry("ts-hello", 1);
    await finishRun("pinned");

    expect(gateway.skillStore.get("skill_1")).toHaveLength(2);
    expect(fetchedVersions).toEqual(["hm_ts-hello@1", "hm_ts-hello@2"]);
    expect(gateway.syncedAgents.at(-1)?.skills).toEqual([
      { skillId: "skill_1", version: "1" },
    ]);
  });

  test("a removed skill is detached from the agent and its upload is kept for other agents", async () => {
    carry("ts-hello");
    carry("keep");
    await finishRun();
    carried = carried.filter((skill) => skill.name !== "ts-hello");

    await finishRun("again");

    expect(gateway.syncedAgents.at(-1)?.skills).toEqual([
      { skillId: "skill_1", version: "1" },
    ]);
    expect(gateway.deletedSkills).toEqual([]);
    expect(versionRows()).toHaveLength(2);
  });

  test("the last skill removed leaves the agent with no skills and no guidance", async () => {
    carry("ts-hello");
    await finishRun();
    carried = [];

    await finishRun("again");

    expect(gateway.syncedAgents.at(-1)).toEqual({
      skills: [],
      system: "Be brief.",
    });
  });

  test("the per-agent mirrors of the library era are deleted at Anthropic on the next launch", async () => {
    carry("ts-hello");
    db.insert(managedSkills)
      .values({
        agentId,
        anthropicSkillId: "legacy_1",
        anthropicVersion: "1",
        contentHash: "old",
        createdAt: START,
        name: "ts-hello",
        syncedAt: START,
        workspaceId: WORKSPACE,
      })
      .run();

    await finishRun();

    expect(gateway.deletedSkills).toEqual(["legacy_1"]);
    expect(db.select().from(managedSkills).all()).toEqual([]);
    expect(gateway.registered[0]?.skills).toEqual([
      { skillId: "skill_1", version: "1" },
    ]);
  });

  test("more skills than Anthropic takes fail the run before anything is uploaded", async () => {
    for (let index = 0; index < 21; index += 1) {
      carry(`skill-${index}`);
    }
    const { runId } = await start(dom);

    await managed.step(runId);

    expect(runRow(runId)?.status).toBe("failed");
    expect(runRow(runId)?.error).toContain("at most 20 skills");
    expect(gateway.skillStore.size).toBe(0);
  });
});

describe("a poller outage and the reaper", () => {
  test("a reaped managed run sends the interrupt and closes the session", async () => {
    const { runId, sessionId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);

    nowMs += MANAGED_LEASE_MS + SECOND;
    await runs.reapExpiredLeases(SYSTEM_PRINCIPAL);

    expect(runRow(runId)?.status).toBe("interrupted");
    expect(gateway.interrupted).toEqual(["sesn_1"]);
    expect(gateway.deletedVaults).toEqual(["vlt_1"]);
    expect(sessionRow(sessionId)?.closedAt).not.toBeNull();
    expect((await verify(tokenOf("vlt_1"))).ok).toBe(false);
  });

  test("a reaped run that is no longer the session's current run leaves the session alone", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const second = await start(dom, "two");
    db.update(managedSessions)
      .set({ currentRunId: second.runId })
      .where(eq(managedSessions.sessionId, first.sessionId))
      .run();

    nowMs += MANAGED_LEASE_MS + SECOND;
    await runs.reapExpiredLeases(SYSTEM_PRINCIPAL);

    expect(runRow(first.runId)?.status).toBe("interrupted");
    expect(gateway.interrupted).toEqual([]);
    expect(gateway.deletedVaults).toEqual([]);
    expect(sessionRow(first.sessionId)?.closedAt).toBeNull();
  });

  test("a poller down for two minutes does not interrupt the run", async () => {
    const { runId, sessionId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);

    for (let count = 0; count < 6; count += 1) {
      nowMs += 20 * SECOND;
      // biome-ignore lint/performance/noAwaitInLoops: each reap follows the clock
      await runs.reapExpiredLeases(SYSTEM_PRINCIPAL);
    }

    expect(runRow(runId)?.status).toBe("running");
    expect(gateway.interrupted).toEqual([]);
    expect((await verify(tokenOf("vlt_1"))).ok).toBe(true);

    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("pelican"), gateway.idle());
    nowMs += POLL_MS;
    const answer = await managed.step(runId);

    expect(answer).toEqual({ next: null });
    expect(runRow(runId)?.status).toBe("done");
    expect(runRow(runId)?.resultText).toBe("pelican");
    expect(gateway.interrupted).toEqual([]);
    expect(sessionRow(sessionId)?.closedAt).toBeNull();
  });

  test("an outage longer than the lease still ends the run", async () => {
    const { runId } = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(runId);

    nowMs += MANAGED_LEASE_MS + SECOND;
    await runs.reapExpiredLeases(SYSTEM_PRINCIPAL);

    expect(runRow(runId)?.status).toBe("interrupted");
    expect(gateway.interrupted).toEqual(["sesn_1"]);
  });

  test("the sweep ending a run that is not the session's current run leaves the session alone", async () => {
    const first = await start(dom, "one");
    gateway.turns = [[gateway.running()]];
    await managed.step(first.runId);
    const second = await start(dom, "two");

    nowMs += 61 * 60 * SECOND;
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

    expect(runRow(second.runId)?.status).toBe("failed");
    expect(gateway.interrupted).toEqual([]);
    expect(sessionRow(first.sessionId)?.closedAt).toBeNull();
  });
});

describe("secrets", () => {
  const ENV_VALUE = "env-secret-value-0123";
  const PROXY_VALUE = "proxy-secret-value-0123";

  const envSecret = (name: string, value = ENV_VALUE) =>
    secrets.create(dom, { mode: "env", name, value });

  const proxySecret = () =>
    secrets.create(dom, {
      mode: "proxy",
      name: "OPENAI_API_KEY",
      rules: [
        {
          header: "Authorization",
          host: "api.openai.com",
          template: "Bearer {value}",
        },
      ],
      value: PROXY_VALUE,
    });

  /** The environment credentials without their values, for printing and comparing. */
  const envCredentialsOf = (vaultId?: string) =>
    gateway.envCredentials
      .filter(
        (credential) => vaultId === undefined || credential.vaultId === vaultId
      )
      .map(({ hosts, name, vaultId: vault }) => ({
        hosts,
        name,
        vaultId: vault,
      }));

  test("an env secret becomes an environment variable credential with no hosts in the session vault", async () => {
    const env = await envSecret("PLAIN_KEY");
    await secrets.setGrants(dom, agentId, [env.id]);
    const { runId } = await start(dom);

    await drive(runId);

    expect(runRow(runId)?.status).toBe("done");
    expect(envCredentialsOf()).toEqual([
      { hosts: undefined, name: "PLAIN_KEY", vaultId: "vlt_1" },
    ]);
    expect(gateway.envCredentials[0]?.value === ENV_VALUE).toBe(true);
  });

  test("a proxy secret gets a relay token limited to the platform host, and the guidance names the relay", async () => {
    const proxied = await proxySecret();
    await secrets.setGrants(dom, agentId, [proxied.id]);
    const { runId } = await start(dom);

    await drive(runId);

    expect(envCredentialsOf()).toEqual([
      { hosts: ["hm.example"], name: RELAY_TOKEN_ENV, vaultId: "vlt_1" },
    ]);
    const relay = gateway.envCredentials.at(0);
    expect(relay?.value.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(relay?.value === tokenOf("vlt_1")).toBe(true);
    const system = gateway.registered.at(0)?.system;
    expect(system).toContain(`${BASE}/api/egress/api.openai.com/<path>`);
    expect(system?.includes(PROXY_VALUE)).toBe(false);
  });

  test("replacing a granted secret's value starts a fresh session and vault", async () => {
    const env = await envSecret("PLAIN_KEY");
    await secrets.setGrants(dom, agentId, [env.id]);
    const first = await start(dom, "one");
    await drive(first.runId);
    await secrets.update(dom, env.id, { value: "env-secret-value-4567" });
    const second = await start(dom, "two");

    await managed.step(second.runId);

    expect(gateway.sessions.size).toBe(2);
    expect(gateway.sessions.get("sesn_2")?.messages).toEqual(["two"]);
    expect(gateway.deletedVaults).toEqual(["vlt_1"]);
    expect(envCredentialsOf("vlt_2")).toEqual([
      { hosts: undefined, name: "PLAIN_KEY", vaultId: "vlt_2" },
    ]);
  });

  test("revoking the grant starts a fresh session with no secret credentials", async () => {
    const env = await envSecret("PLAIN_KEY");
    await secrets.setGrants(dom, agentId, [env.id]);
    const first = await start(dom, "one");
    await drive(first.runId);
    await secrets.setGrants(dom, agentId, []);
    const second = await start(dom, "two");

    await managed.step(second.runId);

    expect(gateway.sessions.size).toBe(2);
    expect(gateway.deletedVaults).toEqual(["vlt_1"]);
    expect(envCredentialsOf("vlt_2")).toEqual([]);
  });

  test("an agent with no grant creates no secret credentials", async () => {
    const { runId } = await start(dom);

    await drive(runId);

    expect(runRow(runId)?.status).toBe("done");
    expect(gateway.envCredentials).toEqual([]);
    expect(gateway.vaults).toEqual(["vlt_1"]);
  });

  test("more credentials than the vault holds fails the run before anything is created", async () => {
    const ids: string[] = [];
    for (let index = 1; index <= 20; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each secret is created in order
      const secret = await envSecret(`SECRET_${index}`);
      ids.push(secret.id);
    }
    await secrets.setGrants(dom, agentId, ids);
    const { runId } = await start(dom);

    await drive(runId);

    expect(runRow(runId)?.status).toBe("failed");
    expect(runRow(runId)?.error).toBe(
      "A managed agent needs 21 credentials, and the limit is 20."
    );
    expect(gateway.registered).toEqual([]);
    expect(gateway.vaults).toEqual([]);
  });

  test("the run records that secrets were delivered, with names and hosts and no value", async () => {
    const env = await envSecret("PLAIN_KEY");
    const proxied = await proxySecret();
    await secrets.setGrants(dom, agentId, [env.id, proxied.id]);
    const { runId } = await start(dom);

    await drive(runId);

    const delivered = runEvents(runId).filter(
      (event) => event.type === "secret.delivered"
    );
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]?.payload ?? "{}")).toMatchObject({
      env: ["PLAIN_KEY"],
      proxy: [{ hosts: ["api.openai.com"], name: "OPENAI_API_KEY" }],
      surface: "managed",
    });
    const everything = JSON.stringify(runEvents(runId));
    expect(everything.includes(ENV_VALUE)).toBe(false);
    expect(everything.includes(PROXY_VALUE)).toBe(false);
  });

  test("a delivery event that fails to record does not fail the launch", async () => {
    const env = await envSecret("PLAIN_KEY");
    await secrets.setGrants(dom, agentId, [env.id]);
    const failing = spyOn(secrets, "announceDelivery").mockRejectedValue(
      new Error("log down")
    );
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    const { runId } = await start(dom);

    await drive(runId);

    expect(failing).toHaveBeenCalled();
    expect(runRow(runId)?.status).toBe("done");
    expect(gateway.sessions.size).toBe(1);
    failing.mockRestore();
    quiet.mockRestore();
  });
});
