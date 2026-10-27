import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import {
  managedAgents,
  managedRuns,
  managedSessions,
  managedSkills,
  managedSkillVersions,
} from "@repo/db/schema/managed";
import { runs as runRows } from "@repo/db/schema/runs";
import { slackApps } from "@repo/db/schema/slack";
import { workspaces } from "@repo/db/schema/workspaces";
import { APPROVAL_TTL_MS, QUESTION_TTL_MS } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { SPEAKER_INSTRUCTIONS } from "../agent-prompt.ts";
import { type AgentsService, createAgentsService } from "../agents.ts";
import {
  seedAssignment,
  seedConnector,
  seedCredential,
} from "../connectors/test-seed.ts";
import { createCredentialsService } from "../credentials.ts";
import { importSecretsKey } from "../crypto.ts";
import { createEventsService } from "../events.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService, type LibraryService } from "../library.ts";
import { createRequestsService, type RequestsService } from "../requests.ts";
import {
  importRunTokenKey,
  SESSION_TOKEN_PREFIX,
  verifyAgentToken,
} from "../run-tokens.ts";
import type { Clock, StartRunInput } from "../runs/types.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import { RELAY_TOKEN_ENV } from "../secrets/relay.ts";
import { createSecretsService, type SecretsService } from "../secrets.ts";
import { SLACK_GUIDANCE } from "../slack/guidance.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { advanceCursor, eventsAfter, type SessionEvent } from "./events.ts";
import type {
  ManagedGateway,
  SkillRef,
  SkillUploadFile,
  ToolResultImage,
} from "./gateway.ts";
import { createManagedKeysService, NO_KEY_MESSAGE } from "./keys.ts";
import { LIBRARY_TOKEN_ENV } from "./library-transfer.ts";
import { createManagedRuntime } from "./runtime.ts";
import {
  BUSY_RETRY_MS,
  createManagedService,
  FAILURE_LIMIT,
  type ManagedService,
  type ManagedServiceOptions,
  POLL_MS,
  RUN_MAX_MS,
  taskFolderNote,
  WAITING_POLL_MS,
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
  /** The tool keys each registration or sync asked about. */
  askKeysSent: (readonly string[])[] = [];
  confirmations: {
    decision: "allow" | "deny";
    denyMessage: string | undefined;
    sessionId: string;
    toolUseId: string;
  }[] = [];
  customResults: { sessionId: string; text: string; toolUseId: string }[] = [];
  /** Pictures sent as tool results. */
  imageResults: {
    image: ToolResultImage;
    sessionId: string;
    toolUseId: string;
  }[] = [];
  /** Whether each registration or sync asked for the desktop tools. */
  desktopsSent: boolean[] = [];
  /** Fails the next `confirmTool`, once. */
  confirmFailure: Error | null = null;
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

  /** A built-in tool call that waits for approval. */
  builtinCall(name: string, input: Record<string, unknown>, id: string) {
    return this.event("agent.tool_use", { tool: { id, input, name } }, id);
  }

  /** An MCP call, which names its server. */
  serverCall(
    server: string,
    name: string,
    input: Record<string, unknown>,
    id: string
  ) {
    return this.event(
      "agent.mcp_tool_use",
      { tool: { id, input, name, server } },
      id
    );
  }

  /** A call to a custom tool, which waits for the client's result. */
  customCall(name: string, input: Record<string, unknown>, id: string) {
    return this.event(
      "agent.custom_tool_use",
      { customToolName: name, tool: { id, input, name } },
      id
    );
  }

  /** The session stops, blocked on these calls. */
  blockedOn(...ids: string[]) {
    return this.event("session.status_idle", {
      requiredEventIds: ids,
      stopReason: "requires_action",
    });
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

  confirmTool(
    sessionId: string,
    toolUseId: string,
    decision: "allow" | "deny",
    denyMessage?: string
  ) {
    if (this.confirmFailure) {
      const failure = this.confirmFailure;
      this.confirmFailure = null;
      return Promise.reject(failure);
    }
    this.confirmations.push({ decision, denyMessage, sessionId, toolUseId });
    const session = this.sessions.get(sessionId);
    if (session) {
      this.play(session);
    }
    return Promise.resolve();
  }

  sendCustomToolResult(sessionId: string, toolUseId: string, text: string) {
    this.customResults.push({ sessionId, text, toolUseId });
    const session = this.sessions.get(sessionId);
    if (session) {
      this.play(session);
    }
    return Promise.resolve();
  }

  sendCustomToolImageResult(
    sessionId: string,
    toolUseId: string,
    image: ToolResultImage
  ) {
    this.imageResults.push({ image, sessionId, toolUseId });
    const session = this.sessions.get(sessionId);
    if (session) {
      this.play(session);
    }
    return Promise.resolve();
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
    askKeys: readonly string[];
    desktop?: boolean;
    instructions: string;
    mcpServers: readonly { name: string; url: string }[];
    name: string;
    skills: readonly SkillRef[];
    system: string;
  }) {
    this.agentSeq += 1;
    this.askKeysSent.push(input.askKeys);
    this.desktopsSent.push(input.desktop === true);
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
    askKeys: readonly string[];
    desktop?: boolean;
    skills: readonly SkillRef[];
    system: string;
  }) {
    this.synced.push(input.anthropicAgentId);
    this.askKeysSent.push(input.askKeys);
    this.desktopsSent.push(input.desktop === true);
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
let requests: RequestsService;
let library: LibraryService;
let kicks: string[];
let cancels: string[];
let agentId: string;
let tokenKey: CryptoKey;
let hasKey: boolean;
/** The `desktopScreenshot` dependency the next `buildManaged` hands the service. */
let desktopShot: ManagedServiceOptions["desktopScreenshot"];
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

const buildManaged = (
  publicBaseUrl: string,
  extra: Partial<ManagedServiceOptions> = {}
) => {
  library = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs: memoryLibraryBlobs(),
    clock,
    db,
    events,
  });
  return createManagedService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    desktopScreenshot: desktopShot,
    events,
    gatewayFor: () => gateway,
    keys: {
      rememberEnvironment: keys.rememberEnvironment,
      resolve: (workspaceId) => {
        onResolveKey?.();
        return hasKey ? keys.resolve(workspaceId) : Promise.resolve(null);
      },
    },
    library,
    poller,
    publicBaseUrl,
    requests,
    runs,
    runTokenKey: RUN_TOKEN_KEY,
    secrets,
    skills: skillsSource,
    ...extra,
  });
};

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

/** What the agent is sent for a run: the input, then the run's task folder. */
const told = (text: string, runId: string) =>
  `${text}\n\n${taskFolderNote("pelican", runId)}`;

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
  desktopShot = undefined;
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
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets,
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
      told("Reply with the word pelican", runId),
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

  test("an idle that waits on a custom tool this platform did not register fails the run", async () => {
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.customCall("fetch_coffee", {}, "evt_use"),
        gateway.blockedOn("evt_use"),
      ],
    ];

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
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual([
      told("one", first.runId),
    ]);
    expect(gateway.sessions.get("sesn_2")?.messages).toEqual([
      told("two", second.runId),
    ]);
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
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual([
      told("one", first.runId),
      told("two", second.runId),
    ]);
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
    expect(gateway.sessions.get("sesn_1")?.messages).toEqual([
      told("one", first.runId),
    ]);
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

const installSlackApp = (agent: string) => {
  db.insert(slackApps)
    .values({
      agentId: agent,
      appId: "A0SLACK",
      botToken: null,
      botUserId: "U0BOT",
      createdAt: START,
      id: `app-${agent}`,
      signingSecret: "ciphertext",
      status: "installed",
      teamId: "T0TEAM",
      workspaceId: WORKSPACE,
    })
    .run();
};

describe("agent home", () => {
  const home = "agents/pelican";
  const principal = dom;

  test("the system text names the agent's folder and the library tools that reach it", async () => {
    await finishRun();

    expect(gateway.registered[0]?.system).toContain("agents/pelican/");
    expect(gateway.registered[0]?.system).toContain("library tools");
    expect(gateway.registered[0]?.system).not.toContain("[ATTACHMENT:");
  });

  test("the message names the run's task folder as a library path, and the system text stays the same for every run", async () => {
    const first = await start(dom, "one");
    await drive(first.runId);
    const second = await start(dom, "two");
    await drive(second.runId);

    const [message] = gateway.sessions.get("sesn_1")?.messages ?? [];
    expect(message).toContain(`agents/pelican/tasks/${first.runId}`);
    expect(message).toContain("library tools");
    expect(gateway.sessions.get("sesn_1")?.messages[1]).toContain(
      `agents/pelican/tasks/${second.runId}`
    );
    // The run id is not in the system text, so the agent and its session are reused.
    expect(gateway.registered).toHaveLength(1);
    expect(gateway.registered[0]?.system).not.toContain(first.runId);
  });

  test("the system text carries the Slack line when the agent has an installed Slack app", async () => {
    installSlackApp(agentId);

    await finishRun();

    expect(gateway.registered[0]?.system).toContain(SLACK_GUIDANCE);
  });

  test("the system text has no Slack line when the agent has no Slack app", async () => {
    await finishRun();

    expect(gateway.registered[0]?.system).not.toContain(SLACK_GUIDANCE);
  });

  test("a first run creates the agent's folder when it is missing", async () => {
    await expect(library.stat(principal, home)).rejects.toThrow();

    await finishRun();

    const entry = await library.stat(principal, home);
    expect(entry.kind).toBe("dir");
  });

  test("a second run does not create the folder again", async () => {
    const mkdir = spyOn(library, "mkdir");

    await finishRun();
    await finishRun("again");

    expect(mkdir).toHaveBeenCalledTimes(1);
  });
});

describe("skills", () => {
  test("an agent without skills registers none and gets no skills guidance", async () => {
    await finishRun();

    expect(gateway.registered[0]?.skills).toEqual([]);
    expect(gateway.registered[0]?.system).toContain("Be brief.");
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
      system: expect.stringContaining("Be brief."),
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
    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("one"), gateway.idle());
    nowMs += POLL_MS;
    await managed.step(first.runId);
    expect(runRow(first.runId)?.status).toBe("done");
    const second = await start(dom, "two");

    nowMs += 61 * 60 * SECOND;
    await runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

    expect(runRow(second.runId)?.status).toBe("failed");
    expect(gateway.interrupted).toEqual([]);
    expect(sessionRow(first.sessionId)?.closedAt).toBeNull();
  });
});

describe("approvals and questions", () => {
  const ask = (toolKey: string) =>
    requests.setRule(dom, { agentId, mode: "ask", toolKey });

  const pending = () => requests.listPending(dom);

  /** Starts a run whose first turn stops on a built-in call that needs approval. */
  const blockedOnBash = async () => {
    await ask("bash");
    const run = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.builtinCall("bash", { command: "ls" }, "evt_bash"),
        gateway.blockedOn("evt_bash"),
      ],
      [gateway.running()],
    ];
    await managed.step(run.runId);
    return run;
  };

  const answerApproval = async (
    decision: "allow_once" | "deny" | "always_allow",
    note?: string
  ) => {
    const [request] = await pending();
    await requests.answer(dom, {
      answer: { decision, ...(note === undefined ? {} : { note }) },
      requestId: request?.id ?? "",
      via: "web",
    });
  };

  test("a requires_action idle opens one request and the run waits", async () => {
    const { runId } = await blockedOnBash();

    expect(runRow(runId)?.error).toBeNull();
    expect(runRow(runId)?.status).toBe("waiting");
    const [request, ...rest] = await pending();
    expect(rest).toEqual([]);
    expect(request).toMatchObject({
      kind: "approval",
      status: "pending",
      toolKey: "bash",
      toolName: "bash",
      toolUseId: "evt_bash",
    });
    expect(request?.display).toMatchObject({ input: { command: "ls" } });

    // Stepping again neither opens another request nor leaves the wait.
    expect(await managed.step(runId)).toEqual({ next: WAITING_POLL_MS });
    expect(await pending()).toHaveLength(1);
    expect(gateway.confirmations).toEqual([]);
    expect(runRow(runId)?.status).toBe("waiting");
  });

  test("the first step answers with the slow interval, and a run with no request keeps the fast one", async () => {
    await ask("bash");
    const waiting = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.builtinCall("bash", {}, "evt_bash"),
        gateway.blockedOn("evt_bash"),
      ],
    ];

    expect(await managed.step(waiting.runId)).toEqual({
      next: WAITING_POLL_MS,
    });
  });

  test("an allow sends one tool confirmation, even over two steps", async () => {
    const { runId } = await blockedOnBash();
    await answerApproval("allow_once");

    expect(kicks).toContain(runId);
    await managed.step(runId);
    await managed.step(runId);
    await managed.step(runId);

    expect(gateway.confirmations).toEqual([
      {
        decision: "allow",
        denyMessage: undefined,
        sessionId: "sesn_1",
        toolUseId: "evt_bash",
      },
    ]);
    expect(runRow(runId)?.status).toBe("running");
  });

  test("a deny sends the note, and the run finishes on what the agent says next", async () => {
    const { runId } = await blockedOnBash();
    await answerApproval("deny", "Not on production");

    await managed.step(runId);

    const [confirmation] = gateway.confirmations;
    expect(confirmation?.decision).toBe("deny");
    expect(confirmation?.denyMessage).toContain("Not on production");
    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("Understood"), gateway.idle());
    nowMs += POLL_MS;
    expect(await managed.step(runId)).toEqual({ next: null });
    expect(runRow(runId)?.status).toBe("done");
  });

  test("always allow sends allow, and the next sync clears the rule from the toolset", async () => {
    const { runId } = await blockedOnBash();
    expect(gateway.askKeysSent).toEqual([
      ["bash", "harbourmaster/bash", "harbourmaster/computer_exec"],
    ]);
    await answerApproval("always_allow");

    await managed.step(runId);
    gateway.sessions
      .get("sesn_1")
      ?.events.push(gateway.say("ok"), gateway.idle());
    nowMs += POLL_MS;
    await managed.step(runId);
    expect(runRow(runId)?.status).toBe("done");
    expect(gateway.confirmations.map((sent) => sent.decision)).toEqual([
      "allow",
    ]);

    const next = await start(dom, "again");
    await managed.step(next.runId);

    expect(gateway.synced).toEqual(["agent_1"]);
    expect(gateway.askKeysSent.at(-1)).toEqual([]);
  });

  test("a failed send is given back and sent on the next step", async () => {
    const { runId } = await blockedOnBash();
    await answerApproval("allow_once");
    gateway.confirmFailure = new Error("boom");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await managed.step(runId);
    expect(failed.next).not.toBeNull();
    expect(gateway.confirmations).toEqual([]);
    await managed.step(runId);
    await managed.step(runId);
    errors.mockRestore();

    expect(gateway.confirmations).toHaveLength(1);
  });

  test("a mail approval is never sent to the session, and it does not hold the run", async () => {
    const run = await start(dom);
    gateway.turns = [[gateway.running()]];
    await managed.step(run.runId);
    const opened = await requests.open(SYSTEM_PRINCIPAL, {
      input: { to: ["outside@example.com"] },
      kind: "approval",
      runId: run.runId,
      toolKey: "mail:outside@example.com",
      toolName: "mail_send",
      toolUseId: "mail:m1",
    });
    await requests.answer(dom, {
      answer: { decision: "allow_once" },
      requestId: opened.id,
      via: "web",
    });

    await managed.step(run.runId);
    await managed.step(run.runId);

    expect(gateway.confirmations).toEqual([]);
    expect(runRow(run.runId)?.status).toBe("running");
  });

  test("an expired approval sends a deny that says nobody answered", async () => {
    const { runId } = await blockedOnBash();
    nowMs += APPROVAL_TTL_MS + SECOND;
    await requests.expireDue(SYSTEM_PRINCIPAL);

    expect(kicks).toContain(runId);
    await managed.step(runId);

    const [confirmation] = gateway.confirmations;
    expect(confirmation?.decision).toBe("deny");
    expect(confirmation?.denyMessage).toContain("Nobody answered");
    expect(runRow(runId)?.status).toBe("running");
  });

  test("a cancelled takeover sends a tool result that says the person cancelled", async () => {
    const { runId } = await blockedOnBash();
    await db.insert(machines).values({
      capabilities: "{}",
      createdAt: new Date(nowMs).toISOString(),
      credentialHash: "hash",
      enrolledBy: "user_dom",
      id: "computer",
      name: "Computer",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    });
    await db
      .update(agentRows)
      .set({ computerMachineId: "computer" })
      .where(eq(agentRows.id, agentId));
    const takeover = await requests.open(SYSTEM_PRINCIPAL, {
      kind: "takeover",
      reason: "log in",
      runId,
      toolUseId: "evt_takeover",
    });
    await requests.cancel(dom, takeover.id);

    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      { text: expect.stringContaining("cancelled"), toolUseId: "evt_takeover" },
    ]);
  });

  test("an MCP call is keyed by its server and shown with its name", async () => {
    await ask("harbourmaster/post_message");
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.serverCall(
          "harbourmaster",
          "post_message",
          { text: "hi" },
          "evt_post"
        ),
        gateway.blockedOn("evt_post"),
      ],
    ];

    await managed.step(runId);

    expect(gateway.askKeysSent).toEqual([["harbourmaster/post_message"]]);
    expect(await pending()).toMatchObject([
      {
        toolKey: "harbourmaster/post_message",
        toolName: "harbourmaster/post_message",
      },
    ]);
  });

  test("a blocked call from an earlier page is still found", async () => {
    await ask("bash");
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.builtinCall("bash", { command: "pwd" }, "evt_bash"),
      ],
    ];
    await managed.step(runId);
    gateway.sessions.get("sesn_1")?.events.push(gateway.blockedOn("evt_bash"));
    nowMs += POLL_MS;

    await managed.step(runId);

    expect(await pending()).toMatchObject([{ toolUseId: "evt_bash" }]);
    expect(runRow(runId)?.status).toBe("waiting");
  });

  test("an ask_user call opens a question and its answer comes back as the tool result", async () => {
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.customCall(
          "ask_user",
          { choices: ["staging", "production"], question: "Which one?" },
          "evt_q"
        ),
        gateway.blockedOn("evt_q"),
      ],
      [gateway.running()],
    ];
    await managed.step(runId);

    const [request] = await pending();
    expect(request).toMatchObject({ kind: "question", toolUseId: "evt_q" });
    expect(request?.display).toEqual({
      questions: [
        { choices: ["staging", "production"], question: "Which one?" },
      ],
    });
    await requests.answer(dom, {
      answer: { answers: { "Which one?": "staging" } },
      requestId: request?.id ?? "",
      via: "slack",
    });
    await managed.step(runId);
    await managed.step(runId);

    expect(gateway.customResults).toEqual([
      {
        sessionId: "sesn_1",
        text: "Q: Which one? A: staging",
        toolUseId: "evt_q",
      },
    ]);
    expect(gateway.confirmations).toEqual([]);
  });

  test("an unanswered question sends the expiry text as the tool result", async () => {
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.customCall("ask_user", { question: "Which one?" }, "evt_q"),
        gateway.blockedOn("evt_q"),
      ],
    ];
    await managed.step(runId);
    nowMs += QUESTION_TTL_MS + SECOND;
    await requests.expireDue(SYSTEM_PRINCIPAL);

    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      { text: expect.stringContaining("Nobody answered"), toolUseId: "evt_q" },
    ]);
  });

  test("the age limit ignores the time spent waiting", async () => {
    const { runId } = await blockedOnBash();
    nowMs += RUN_MAX_MS - SECOND;
    await managed.step(runId);
    await answerApproval("allow_once");
    // The wait was nearly an hour and the run has worked a few seconds since.
    nowMs += 2 * SECOND;
    await managed.step(runId);

    expect(runRow(runId)?.status).toBe("running");
    expect(gateway.interrupted).toEqual([]);

    nowMs += RUN_MAX_MS - SECOND;
    await managed.step(runId);
    expect(runRow(runId)?.status).toBe("failed");
    expect(runRow(runId)?.error).toBe("The run took too long");
  });

  test("a run that waits longer than the limit is not stopped for it", async () => {
    const { runId } = await blockedOnBash();

    nowMs += RUN_MAX_MS + 10 * 60 * SECOND;
    await managed.step(runId);

    expect(runRow(runId)?.status).toBe("waiting");
    expect(gateway.interrupted).toEqual([]);
  });

  test("a run with no rules still registers its toolsets without asking about any tool", async () => {
    const { runId } = await start(dom);

    await drive(runId);

    expect(gateway.askKeysSent).toEqual([[]]);
    expect(runRow(runId)?.status).toBe("done");
  });

  test("the bash switch sends the platform bash tool to ask about", async () => {
    await ask("bash");
    const { runId } = await start(dom);

    await drive(runId);

    expect(gateway.askKeysSent.at(-1)).toContain("harbourmaster/bash");
  });

  test("the write switch sends the platform library write tool to ask about", async () => {
    await ask("write");
    const { runId } = await start(dom);

    await drive(runId);

    expect(gateway.askKeysSent.at(-1)).toContain("harbourmaster/library_write");
  });

  test("with neither switch on, no platform tool is sent to ask about", async () => {
    await ask("read");
    const { runId } = await start(dom);

    await drive(runId);

    expect(gateway.askKeysSent.at(-1)).toEqual(["read"]);
  });

  test("a step that fails while opening the request reads the idle again", async () => {
    await ask("bash");
    const { runId } = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.builtinCall("bash", { command: "ls" }, "evt_bash"),
        gateway.blockedOn("evt_bash"),
      ],
    ];
    const open = spyOn(requests, "open").mockRejectedValueOnce(
      new Error("boom")
    );
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await managed.step(runId);
    expect(failed.next).not.toBeNull();
    expect(await pending()).toEqual([]);
    await managed.step(runId);
    open.mockRestore();
    errors.mockRestore();

    expect(await pending()).toHaveLength(1);
    expect(runRow(runId)?.status).toBe("waiting");
  });

  test("the minute tick wakes a run that waits for a person", async () => {
    const { runId } = await blockedOnBash();

    const { kicked } = await managed.rearm();

    expect(kicked).toEqual([runId]);
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
    expect(gateway.sessions.get("sesn_2")?.messages).toEqual([
      told("two", second.runId),
    ]);
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

test("managed voice and hands to enter system text and each change re-syncs", async () => {
  const target = await agents.create(dom, {
    model: "sonnet",
    name: "Helper",
    runtime: "managed",
  });
  await agents.update(dom, agentId, {
    handsTo: [target.id],
    soul: "Speak warmly.",
  });
  await drive((await start(dom, "one")).runId);
  expect(gateway.registered[0]?.system).toStartWith(
    `Be brief.\n\n${SPEAKER_INSTRUCTIONS}\n\n## Voice\nSpeak warmly.\n\nYou can hand work to: Helper (use send_message)\n\n`
  );
  await agents.update(dom, agentId, { soul: "Speak plainly." });
  await drive((await start(dom, "two")).runId);
  expect(gateway.syncedAgents.at(-1)?.system).toContain(
    "## Voice\nSpeak plainly."
  );
  await agents.update(dom, agentId, { handsTo: [] });
  await drive((await start(dom, "three")).runId);
  expect(gateway.syncedAgents).toHaveLength(2);
  expect(gateway.syncedAgents.at(-1)?.system).not.toContain(
    "You can hand work to:"
  );
});

describe("the agent's computer", () => {
  const PNG = "iVBORw0KGgo=";

  /** Gives the agent a computer, with or without a desktop. */
  const giveComputer = async (desktop: boolean, id = "computer") => {
    await db.insert(machines).values({
      capabilities: "{}",
      computerCapabilities: JSON.stringify({ desktop }),
      computerStatus: "online",
      createdAt: new Date(nowMs).toISOString(),
      credentialHash: "computer-only:x",
      enrolledBy: "user_dom",
      id,
      name: "Computer",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    });
    await db
      .update(agentRows)
      .set({ computerMachineId: id })
      .where(eq(agentRows.id, agentId));
  };

  const takeComputerAway = () =>
    db
      .update(agentRows)
      .set({ computerMachineId: null })
      .where(eq(agentRows.id, agentId));

  /** Starts a run whose first turn calls one custom tool and stops on it. */
  const callTool = async (
    name: string,
    input: Record<string, unknown> = {}
  ) => {
    const run = await start(dom);
    gateway.turns = [
      [
        gateway.running(),
        gateway.customCall(name, input, "evt_use"),
        gateway.blockedOn("evt_use"),
      ],
      [gateway.running()],
    ];
    return run;
  };

  test("the desktop tools are declared only for a computer that reports a desktop", async () => {
    await finishRun();
    await giveComputer(false);
    await finishRun();
    await takeComputerAway();
    await db.delete(machines);
    await giveComputer(true);
    await finishRun();

    expect(gateway.desktopsSent).toEqual([false, false, true]);
  });

  test("the system text carries the computer paragraph when a computer is attached", async () => {
    await giveComputer(true);

    await finishRun();

    expect(gateway.registered[0]?.system).toContain("computer_exec");
    expect(gateway.registered[0]?.system).toContain("desktop_screenshot");
  });

  test("the system text has no computer paragraph without a computer", async () => {
    await finishRun();

    expect(gateway.registered[0]?.system).not.toContain("computer_exec");
  });

  test("the system text leaves out the desktop lines for a computer without one", async () => {
    await giveComputer(false);

    await finishRun();

    expect(gateway.registered[0]?.system).toContain("computer_exec");
    expect(gateway.registered[0]?.system).not.toContain("desktop_screenshot");
  });

  test("a screenshot call is answered with an image block, and the run goes on", async () => {
    await giveComputer(true);
    const asked: string[] = [];
    desktopShot = (machineId) => {
      asked.push(machineId);
      return Promise.resolve({
        image: { data: PNG, mediaType: "image/png" },
        ok: true,
      });
    };
    managed = buildManaged(BASE);
    const { runId } = await callTool("desktop_screenshot");

    const step = await managed.step(runId);

    expect(asked).toEqual(["computer"]);
    expect(gateway.imageResults).toEqual([
      {
        image: { data: PNG, mediaType: "image/png" },
        sessionId: "sesn_1",
        toolUseId: "evt_use",
      },
    ]);
    expect(gateway.customResults).toEqual([]);
    expect(runRow(runId)?.status).toBe("running");
    // The session works again at once, so it is read soon, not after a wait for a person.
    expect(step).toEqual({ next: POLL_MS });
  });

  test("an offline or busy computer becomes a text result", async () => {
    await giveComputer(true);
    desktopShot = () =>
      Promise.resolve({ message: "The computer is offline.", ok: false });
    managed = buildManaged(BASE);
    const { runId } = await callTool("desktop_screenshot");

    await managed.step(runId);

    expect(gateway.imageResults).toEqual([]);
    expect(gateway.customResults).toEqual([
      {
        sessionId: "sesn_1",
        text: "The computer is offline.",
        toolUseId: "evt_use",
      },
    ]);
    expect(runRow(runId)?.status).toBe("running");
  });

  test("a screenshot that throws becomes a text result too", async () => {
    await giveComputer(true);
    desktopShot = () => Promise.reject(new Error("socket closed"));
    managed = buildManaged(BASE);
    const { runId } = await callTool("desktop_screenshot");

    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      { text: expect.stringContaining("failed"), toolUseId: "evt_use" },
    ]);
    expect(runRow(runId)?.status).toBe("running");
  });

  test("a screenshot call from an agent with no desktop gets a text result", async () => {
    desktopShot = () => Promise.reject(new Error("must not be called"));
    managed = buildManaged(BASE);
    const { runId } = await callTool("desktop_screenshot");

    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      { text: expect.stringContaining("no computer"), toolUseId: "evt_use" },
    ]);
    expect(runRow(runId)?.status).toBe("running");
  });

  test("a screenshot call with no screenshot dependency gets a text result", async () => {
    await giveComputer(true);
    const { runId } = await callTool("desktop_screenshot");

    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      { text: expect.stringContaining("not available"), toolUseId: "evt_use" },
    ]);
  });

  test("attaching a computer retires the session on the next run", async () => {
    const first = await start(dom, "one");
    await drive(first.runId);
    await giveComputer(true);
    const second = await start(dom, "two");

    await managed.step(second.runId);

    expect(gateway.synced).toEqual(["agent_1"]);
    expect(gateway.desktopsSent).toEqual([false, true]);
    expect(gateway.sessions.size).toBe(2);
    expect(gateway.deletedVaults).toEqual(["vlt_1"]);
  });

  test("detaching the computer retires the session on the next run", async () => {
    await giveComputer(true);
    const first = await start(dom, "one");
    await drive(first.runId);
    await takeComputerAway();
    const second = await start(dom, "two");

    await managed.step(second.runId);

    expect(gateway.desktopsSent).toEqual([true, false]);
    expect(gateway.sessions.size).toBe(2);
  });

  test("a second run with the same computer reuses the session", async () => {
    await giveComputer(true);
    const first = await start(dom, "one");
    await drive(first.runId);
    const second = await start(dom, "two");

    await managed.step(second.runId);

    expect(gateway.sessions.size).toBe(1);
    expect(gateway.synced).toEqual([]);
  });

  test("a request_human_takeover call opens a takeover and its cancel comes back as the tool result", async () => {
    await giveComputer(true);
    const { runId } = await callTool("request_human_takeover", {
      reason: "A CAPTCHA blocks the login.",
    });

    const step = await managed.step(runId);

    const [request] = await requests.listPending(dom);
    expect(request).toMatchObject({
      kind: "takeover",
      toolUseId: "evt_use",
    });
    expect(request?.display).toEqual({
      machineId: "computer",
      reason: "A CAPTCHA blocks the login.",
    });
    expect(step).toEqual({ next: WAITING_POLL_MS });
    expect(runRow(runId)?.status).toBe("waiting");

    await requests.cancel(dom, request?.id ?? "");
    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      { text: expect.stringContaining("cancelled"), toolUseId: "evt_use" },
    ]);
  });

  test("a takeover the agent cannot have becomes a text result, not a failed run", async () => {
    const { runId } = await callTool("request_human_takeover", {
      reason: "log in",
    });

    await managed.step(runId);

    expect(gateway.customResults).toMatchObject([
      {
        text: expect.stringContaining("No takeover was opened"),
        toolUseId: "evt_use",
      },
    ]);
    expect(runRow(runId)?.status).toBe("running");
    expect(await requests.listPending(dom)).toEqual([]);
  });
});

describe("library transfer", () => {
  const HELPER = "console.log('library helper')";

  const withHelper = () => {
    managed = buildManaged(BASE, { libraryTransfer: { helper: HELPER } });
  };

  test("without the helper, no library token and no library skill", async () => {
    await finishRun();

    expect(gateway.envCredentials).toEqual([]);
    expect(gateway.registered[0]?.skills).toEqual([]);
    expect(gateway.registered[0]?.system).not.toContain("library-transfer");
  });

  test("the session vault gets the session token as a library token limited to the platform host", async () => {
    withHelper();

    await finishRun();

    expect(
      gateway.envCredentials.map(({ hosts, name, vaultId }) => ({
        hosts,
        name,
        vaultId,
      }))
    ).toEqual([
      { hosts: ["hm.example"], name: LIBRARY_TOKEN_ENV, vaultId: "vlt_1" },
    ]);
    const credential = gateway.envCredentials.at(0);
    expect(credential?.value === tokenOf("vlt_1")).toBe(true);
    expect(credential?.value.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
  });

  test("the built-in skill carries SKILL.md and the helper, and the system text says when to run it", async () => {
    withHelper();

    await finishRun();

    const [upload] = [...gateway.skillStore.values()];
    const files = upload?.[0]?.files ?? [];
    expect(files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "scripts/library.js",
    ]);
    expect(
      new TextDecoder().decode(
        files.find((file) => file.path === "scripts/library.js")?.content
      )
    ).toBe(HELPER);
    expect(gateway.registered[0]?.skills).toHaveLength(1);
    const system = gateway.registered[0]?.system;
    expect(system).toContain("library-transfer");
    expect(system).toContain(`--url ${BASE}`);
    expect(system).toContain("agents/pelican");
    expect(system).toContain(`$${LIBRARY_TOKEN_ENV}`);
    expect(versionRows()).toMatchObject([
      { skillId: "builtin-library-transfer-w1", version: expect.any(Number) },
    ]);
  });

  test("it sits beside the agent's own skills, and is uploaded once", async () => {
    withHelper();
    carry("ts-hello");

    await finishRun();
    await finishRun("again");

    expect(gateway.registered[0]?.skills).toHaveLength(2);
    expect(gateway.skillStore.size).toBe(2);
    expect(versionRows()).toHaveLength(2);
  });

  test("a new helper is a new version of the built-in skill", async () => {
    withHelper();
    await finishRun();

    managed = buildManaged(BASE, {
      libraryTransfer: { helper: "console.log('v2')" },
    });
    await finishRun("again");

    expect(versionRows().map((row) => row.skillId)).toEqual([
      "builtin-library-transfer-w1",
      "builtin-library-transfer-w1",
    ]);
    expect(gateway.synced.length).toBeGreaterThan(0);
  });

  test("an agent already at the skill limit gets neither the skill nor the guidance", async () => {
    withHelper();
    for (let index = 0; index < 20; index += 1) {
      carry(`skill-${index}`);
    }

    const runId = await finishRun();

    expect(runRow(runId)?.status).toBe("done");
    expect(gateway.registered[0]?.skills).toHaveLength(20);
    expect(gateway.registered[0]?.system).not.toContain("--url");
  });
});
