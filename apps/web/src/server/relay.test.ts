import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { migrated } from "@repo/db/test-db";
import { relayFrameSchema } from "@repo/protocol/machine";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq, inArray } from "drizzle-orm";
import { composeWith } from "./compose.ts";
import { PRESENCE_ALARM_MS } from "./computer-relay-core.ts";
import { createMachineRelayCore } from "./machine-relay-core.ts";
import {
  createRelayCore,
  LAST_SEEN_WRITE_MS,
  PRESENCE_TIMEOUT_MS,
  type RelaySocket,
  type RelayStorage,
} from "./relay-core.ts";

const START = Date.parse("2026-10-16T09:30:00.000Z");
const ORG = "org_a";
const REPLACED = 1012;
const REJECTED = 4401;

class FakeSocket implements RelaySocket {
  attachment: unknown = null;
  closes: { code?: number; reason?: string }[] = [];
  sent: string[] = [];

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(data: string | ArrayBuffer) {
    // Only the text frames matter to these tests. A viewer also gets binary frames.
    if (typeof data === "string") {
      this.sent.push(data);
    }
  }

  serializeAttachment(value: unknown) {
    this.attachment = value;
  }

  frames() {
    return this.sent.map((raw) => relayFrameSchema.parse(JSON.parse(raw)));
  }
}

class FakeStorage implements RelayStorage {
  alarm: number | null = null;
  values = new Map<string, unknown>();

  delete(key: string) {
    return Promise.resolve(this.values.delete(key));
  }

  deleteAlarm() {
    this.alarm = null;
    return Promise.resolve();
  }

  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  getAlarm() {
    return Promise.resolve(this.alarm);
  }

  put<T>(key: string, value: T) {
    this.values.set(key, value);
    return Promise.resolve();
  }

  setAlarm(at: number) {
    this.alarm = at;
    return Promise.resolve();
  }
}

const helloFrame = JSON.stringify({
  agents: [],
  capabilities: { agentSdk: "0.2.0", container: false },
  daemonVersion: "0.1.0",
  type: "hello",
});
const helloWithFeatures = (features: string[]) =>
  JSON.stringify({ ...JSON.parse(helloFrame), features });
const pingFrame = (at: number) =>
  JSON.stringify({ at: new Date(at).toISOString(), type: "ping" });

let db: ReturnType<typeof migrated>;
let nowMs: number;
let services: ReturnType<typeof composeWith>["services"];
let storage: FakeStorage;
let open: FakeSocket[];
let user: Extract<Principal, { kind: "user" }>;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const newCore = () =>
  createRelayCore({
    machines: services.machines,
    now: () => nowMs,
    sockets: () => open,
    storage,
  });

let core: ReturnType<typeof newCore>;

/** Enrols a machine and returns its id and the identity the Worker would stamp. */
const enrolMachine = async (name = "laptop") => {
  const { code } = await services.machines.createEnrollToken(user, {
    machineName: name,
  });
  const enrolled = await services.machines.enroll({ code, singleUser: false });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return {
    machineId: enrolled.machineId,
    workspaceId: user.workspaceId,
  };
};

/** The Worker's side of a connection: `connect`, then the runtime accepts the socket. */
const dial = async (identity: { machineId: string; workspaceId: string }) => {
  await core.connect(identity);
  const socket = new FakeSocket();
  open.push(socket);
  return socket;
};

/** The runtime clears a pending alarm before it runs the handler. */
const fireAlarm = () => {
  storage.alarm = null;
  return core.alarm();
};

const machineRow = (machineId: string) =>
  db.select().from(machines).where(eq(machines.id, machineId)).get();

const machineEvents = () =>
  db
    .select()
    .from(events)
    .where(inArray(events.type, ["machine.online", "machine.offline"]))
    .all();

beforeEach(async () => {
  db = migrated([ORG]);
  nowMs = START;
  open = [];
  storage = new FakeStorage();
  const blobs = new Map<string, string>();
  ({ services } = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(blobs.get(key) ?? null),
        put: (key, body) => {
          blobs.set(key, body);
          return Promise.resolve();
        },
      },
      clock,
      devFakeRuntime: false,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  }));
  const workspace = await services.workspaces.forOrg({ clerkOrgId: ORG });
  if (!workspace) {
    throw new Error("no workspace");
  }
  user = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
  core = newCore();
});

describe("MachineRelay hello", () => {
  test("a hello gets hello_ack and marks the machine online", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);

    await core.message(socket, helloFrame);

    expect(socket.frames()).toEqual([
      {
        machineId: identity.machineId,
        serverTime: new Date(START).toISOString(),
        type: "hello_ack",
      },
    ]);
    const row = machineRow(identity.machineId);
    expect(row?.status).toBe("online");
    expect(row?.lastSeenAt).toBe(new Date(START).toISOString());
    expect(row?.daemonVersion).toBe("0.1.0");
    expect(JSON.parse(row?.capabilities ?? "{}")).toEqual({
      agentSdk: "0.2.0",
      container: false,
      daemonVersion: "0.1.0",
      features: [],
    });
    expect(machineEvents().map((event) => event.type)).toEqual([
      "machine.online",
    ]);
  });

  test("hello persists daemon features and clears them for an older daemon", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloWithFeatures(["parallel-subagents"]));
    expect(
      JSON.parse(machineRow(identity.machineId)?.capabilities ?? "{}").features
    ).toEqual(["parallel-subagents"]);
    await core.message(socket, helloFrame);
    expect(
      JSON.parse(machineRow(identity.machineId)?.capabilities ?? "{}").features
    ).toEqual([]);
  });

  test("a hello's doctor problems land on the machine row and an older daemon's hello leaves them", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    const problem = { message: "Fix: claude auth login", name: "claude login" };
    await core.message(
      socket,
      JSON.stringify({ ...JSON.parse(helloFrame), doctor: [problem] })
    );
    expect(
      JSON.parse(machineRow(identity.machineId)?.doctorProblems ?? "null")
    ).toEqual([problem]);
    expect(socket.frames()[0]).toMatchObject({ type: "hello_ack" });
    await core.message(socket, helloFrame);
    expect(
      JSON.parse(machineRow(identity.machineId)?.doctorProblems ?? "null")
    ).toEqual([problem]);
  });

  test("frames that are not valid daemon frames are ignored", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);

    await core.message(socket, "not json");
    await core.message(socket, JSON.stringify({ type: "offer" }));
    await core.message(socket, new ArrayBuffer(4));

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([]);
    expect(machineRow(identity.machineId)?.status).toBe("offline");
  });

  test("a hello with two queued runs produces two offers, oldest first", async () => {
    const identity = await enrolMachine();
    const agent = await services.agents.create(user, {
      machineId: identity.machineId,
      model: "claude-sonnet-4-5",
      name: "Pelican",
      runtime: "machine",
    });
    const start = (text: string) =>
      services.runs.startRun(user, {
        agentId: agent.id,
        input: { text },
        session: { origin: "ui" },
      });
    // Inserted newest first, so insertion order is not the answer.
    nowMs = START + 2000;
    const newer = await start("newer");
    nowMs = START + 1000;
    const older = await start("older");
    nowMs = START + 3000;
    const socket = await dial(identity);

    await core.message(socket, helloFrame);

    expect(socket.frames()).toEqual([
      expect.objectContaining({ type: "hello_ack" }),
      { agentId: agent.id, runId: older.runId, type: "offer" },
      { agentId: agent.id, runId: newer.runId, type: "offer" },
    ]);
  });

  test("a hello from a revoked machine closes with 4401 and gets no ack", async () => {
    const identity = await enrolMachine();
    await services.machines.revoke(user, identity.machineId);
    const socket = await dial(identity);

    await core.message(socket, helloFrame);

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([
      { code: REJECTED, reason: "Credential rejected." },
    ]);
    expect(machineRow(identity.machineId)?.status).toBe("revoked");
  });
});

describe("MachineRelay connections", () => {
  test("a replacing connection closes the old one with 1012 and leaves the machine online", async () => {
    const identity = await enrolMachine();
    const first = await dial(identity);
    await core.message(first, helloFrame);

    const second = await dial(identity);
    await core.closed(first);

    expect(first.closes).toEqual([
      { code: REPLACED, reason: "Replaced by a newer connection." },
    ]);
    expect(second.closes).toEqual([]);
    expect(machineRow(identity.machineId)?.status).toBe("online");
  });

  test("closing the last socket marks the machine offline", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);

    open = [];
    await core.closed(socket);

    expect(machineRow(identity.machineId)?.status).toBe("offline");
    expect(machineEvents().map((event) => event.type)).toEqual([
      "machine.online",
      "machine.offline",
    ]);
    expect(storage.alarm).toBeNull();
  });

  test("revoking closes every open socket with 4401", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);

    core.revoke();

    expect(socket.closes).toEqual([
      { code: REJECTED, reason: "Credential rejected." },
    ]);
  });

  test("offer and cancel go to the open sockets", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);

    core.offer({ agentId: "agent_1", runId: "run_1" });
    core.cancel("run_2");

    expect(socket.frames()).toEqual([
      { agentId: "agent_1", runId: "run_1", type: "offer" },
      { runId: "run_2", type: "cancel" },
    ]);
  });
});

describe("MachineRelay library announcements", () => {
  test("announce sends one library_changed frame to a socket whose hello named library-live", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(
      socket,
      helloWithFeatures(["library-sync", "library-live"])
    );
    const sentBefore = socket.sent.length;

    core.announce(["notes/a.md", "skills/b.md"]);

    expect(socket.frames().slice(sentBefore)).toEqual([
      { paths: ["notes/a.md", "skills/b.md"], type: "library_changed" },
    ]);
  });

  test("announce skips a socket whose hello had no features", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);
    const sentBefore = socket.sent.length;

    core.announce(["notes/a.md"]);

    expect(socket.sent.length).toBe(sentBefore);
  });

  test("announce skips a socket that sent no hello yet", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);

    core.announce(["notes/a.md"]);

    expect(socket.sent).toEqual([]);
  });
});

describe("MachineRelay presence", () => {
  test("the alarm after silence marks the machine offline", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);
    expect(storage.alarm).toBe(START + PRESENCE_TIMEOUT_MS);

    nowMs = START + PRESENCE_TIMEOUT_MS;
    await fireAlarm();

    expect(machineRow(identity.machineId)?.status).toBe("offline");
    const [, offline] = machineEvents();
    expect(offline?.type).toBe("machine.offline");
    expect(JSON.parse(offline?.payload ?? "{}")).toMatchObject({
      machineId: identity.machineId,
      reason: "silent",
    });
  });

  test("the alarm re-arms instead of marking offline while pings keep coming", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);

    nowMs = START + 60_000;
    await core.message(socket, pingFrame(nowMs));
    nowMs = START + PRESENCE_TIMEOUT_MS;
    await fireAlarm();

    expect(machineRow(identity.machineId)?.status).toBe("online");
    expect(storage.alarm).toBe(START + 60_000 + PRESENCE_TIMEOUT_MS);
  });

  test("a ping after the alarm marked the machine offline brings it back online", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);
    nowMs = START + PRESENCE_TIMEOUT_MS;
    await fireAlarm();

    nowMs += 5000;
    await core.message(socket, pingFrame(nowMs));

    expect(machineRow(identity.machineId)?.status).toBe("online");
    expect(machineEvents().map((event) => event.type)).toEqual([
      "machine.online",
      "machine.offline",
      "machine.online",
    ]);
    expect(storage.alarm).toBe(nowMs + PRESENCE_TIMEOUT_MS);
  });

  test("a ping writes last_seen_at at most once per throttle window", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);

    nowMs = START + 20_000;
    await core.message(socket, pingFrame(nowMs));
    expect(machineRow(identity.machineId)?.lastSeenAt).toBe(
      new Date(START).toISOString()
    );

    nowMs = START + LAST_SEEN_WRITE_MS;
    await core.message(socket, pingFrame(nowMs));
    expect(machineRow(identity.machineId)?.lastSeenAt).toBe(
      new Date(nowMs).toISOString()
    );
  });

  test("a ping from a machine revoked meanwhile closes the socket with 4401", async () => {
    const identity = await enrolMachine();
    const socket = await dial(identity);
    await core.message(socket, helloFrame);
    await services.machines.revoke(user, identity.machineId);

    nowMs = START + LAST_SEEN_WRITE_MS;
    await core.message(socket, pingFrame(nowMs));

    expect(socket.closes).toEqual([
      { code: REJECTED, reason: "Credential rejected." },
    ]);
  });
});

class TaggedSocket extends FakeSocket {
  tags: string[];

  constructor(tags: string[]) {
    super();
    this.tags = tags;
  }
}

const computerHelloFrame = JSON.stringify({
  arch: "amd64",
  capabilities: {
    desktop: false,
    desktop_unavailable_reason: null,
    git: true,
    python3: true,
    skills: false,
  },
  hostname: "box",
  os: "linux",
  protocol_version: 1,
  run_as_user: "agent",
  type: "hello",
  version: "1.0.0",
  workdir: "/home/agent/sessions",
});

describe("MachineRelay with a daemon and a computer on one object", () => {
  let live: TaggedSocket[];
  let heartbeats: Map<TaggedSocket, number>;
  let pendingWork: Promise<unknown>[];
  let relay: ReturnType<typeof createMachineRelayCore<TaggedSocket>>;

  beforeEach(() => {
    live = [];
    heartbeats = new Map();
    pendingWork = [];
    relay = createMachineRelayCore<TaggedSocket>({
      background: (work) => {
        pendingWork.push(work);
      },
      heartbeatAt: (socket) => heartbeats.get(socket) ?? null,
      machines: services.machines,
      now: () => nowMs,
      // The viewer pump takes one step and then waits, so no timer outlives a test.
      sleep: () => new Promise<void>(() => undefined),
      sockets: () => live,
      storage,
      tagsOf: (socket) => socket.tags,
    });
  });

  /** Waits for the background work the cores handed to `background`. */
  const settle = async () => {
    await Promise.all(pendingWork.splice(0));
  };

  /** A machine with a daemon credential and a computer credential. */
  const enrolBoth = async () => {
    const identity = await enrolMachine();
    const { code } = await services.machines.createEnrollToken(user, {
      machineId: identity.machineId,
      role: "computer",
    });
    const enrolled = await services.machines.enroll({
      arch: "amd64",
      clientVersion: "1.0.0",
      code,
      hostname: "box",
      os: "linux",
      role: "computer",
    });
    if (!enrolled) {
      throw new Error("computer enrol failed");
    }
    return identity;
  };

  const dialDaemon = async (identity: {
    machineId: string;
    workspaceId: string;
  }) => {
    await relay.connect("daemon", identity);
    const socket = new TaggedSocket(["daemon"]);
    live.push(socket);
    await relay.accepted("daemon", socket, 0);
    await settle();
    return socket;
  };

  const dialComputer = async (identity: {
    machineId: string;
    workspaceId: string;
  }) => {
    const { generation } = await relay.connect("computer", identity);
    const socket = new TaggedSocket(["computer"]);
    live.push(socket);
    await relay.accepted("computer", socket, generation);
    await settle();
    return socket;
  };

  /** The runtime removes a socket from the set before its close handler runs. */
  const hangUp = (socket: TaggedSocket) => {
    live = live.filter((other) => other !== socket);
    return relay.closed(socket);
  };

  /** The runtime clears the one alarm before it runs the handler. */
  const fireMachineAlarm = () => {
    storage.alarm = null;
    return relay.alarm();
  };

  const snapshot = () => ({
    alarm: storage.alarm,
    values: new Map(storage.values),
  });

  const sentTypes = (socket: TaggedSocket) =>
    socket.sent.map((raw) => JSON.parse(raw).type);

  test("each hello reaches only its own core", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    const computerSocket = await dialComputer(identity);

    await relay.message(daemonSocket, helloFrame);
    await relay.message(computerSocket, computerHelloFrame);

    expect(daemonSocket.frames()).toEqual([
      {
        machineId: identity.machineId,
        serverTime: new Date(START).toISOString(),
        type: "hello_ack",
      },
    ]);
    expect(computerSocket.sent).toEqual([]);
    const row = machineRow(identity.machineId);
    expect(row?.status).toBe("online");
    expect(row?.computerStatus).toBe("online");
    expect(row?.computerLastSeenAt).toBe(new Date(START).toISOString());
  });

  test("a frame for one role sent on the other role's socket is ignored", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    const computerSocket = await dialComputer(identity);
    await relay.message(daemonSocket, helloFrame);
    await relay.message(computerSocket, computerHelloFrame);
    const beforeDaemonPing = snapshot();
    nowMs = START + LAST_SEEN_WRITE_MS;

    await relay.message(computerSocket, pingFrame(nowMs));
    expect(snapshot()).toEqual(beforeDaemonPing);
    expect(computerSocket.sent).toEqual([]);

    const beforeComputerReply = snapshot();
    await relay.message(
      daemonSocket,
      JSON.stringify({ id: "req_1", ok: true, result_json: "{}" })
    );
    expect(snapshot()).toEqual(beforeComputerReply);
    expect(daemonSocket.sent).toEqual([
      JSON.stringify({
        machineId: identity.machineId,
        serverTime: new Date(START).toISOString(),
        type: "hello_ack",
      }),
    ]);
  });

  test("a computer connecting does not close the daemon's socket", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);

    const computerSocket = await dialComputer(identity);

    expect(daemonSocket.closes).toEqual([]);
    expect(computerSocket.closes).toEqual([]);
  });

  test("a daemon connecting does not close the computer's socket", async () => {
    const identity = await enrolBoth();
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);

    const daemonSocket = await dialDaemon(identity);

    expect(computerSocket.closes).toEqual([]);
    expect(daemonSocket.closes).toEqual([]);
  });

  test("a second computer connection closes the old computer socket and leaves the daemon's alone", async () => {
    const identity = await enrolBoth();
    const first = await dialComputer(identity);
    await relay.message(first, computerHelloFrame);
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);

    const second = await dialComputer(identity);
    await hangUp(first);

    expect(first.closes).toEqual([
      {
        code: 4409,
        reason: "Replaced by a newer connection for this computer.",
      },
    ]);
    expect(second.closes).toEqual([]);
    expect(daemonSocket.closes).toEqual([]);
    const row = machineRow(identity.machineId);
    expect(row?.status).toBe("online");
    expect(row?.computerStatus).toBe("online");
  });

  test("closing the computer socket marks only the computer offline", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);

    await hangUp(computerSocket);

    const row = machineRow(identity.machineId);
    expect(row?.computerStatus).toBe("offline");
    expect(row?.status).toBe("online");
  });

  test("closing the daemon socket marks only the daemon offline", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);

    await hangUp(daemonSocket);

    const row = machineRow(identity.machineId);
    expect(row?.status).toBe("offline");
    expect(row?.computerStatus).toBe("online");
  });

  test("revoking closes both sockets with 4401, whatever their tag", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);

    relay.revoke();
    await settle();

    expect(daemonSocket.closes.map((close) => close.code)).toEqual([REJECTED]);
    expect(computerSocket.closes.map((close) => close.code)).toEqual([
      REJECTED,
    ]);
  });

  test("a daemon offer goes to the daemon socket only", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);
    const sentBefore = daemonSocket.sent.length;

    relay.daemon.offer({ agentId: "agent_1", runId: "run_1" });

    expect(daemonSocket.frames().slice(sentBefore)).toEqual([
      { agentId: "agent_1", runId: "run_1", type: "offer" },
    ]);
    expect(computerSocket.sent).toEqual([]);
  });

  test("both cores share one alarm at the earliest wake time", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);

    expect(storage.alarm).toBe(
      Math.min(START + PRESENCE_TIMEOUT_MS, START + PRESENCE_ALARM_MS)
    );

    await hangUp(daemonSocket);

    expect(storage.alarm).toBe(START + PRESENCE_ALARM_MS);
  });

  test("the alarm runs the computer core without marking the daemon offline", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);

    nowMs = START + PRESENCE_ALARM_MS;
    heartbeats.set(computerSocket, nowMs);
    await fireMachineAlarm();

    const row = machineRow(identity.machineId);
    expect(row?.computerLastSeenAt).toBe(new Date(nowMs).toISOString());
    expect(row?.status).toBe("online");
    expect(storage.alarm).toBe(START + PRESENCE_TIMEOUT_MS);
  });

  test("an alarm armed before the mux existed runs the daemon core's alarm", async () => {
    const identity = await enrolMachine();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    for (const key of [...storage.values.keys()]) {
      if (key.startsWith("alarm:")) {
        storage.values.delete(key);
      }
    }
    storage.alarm = START + PRESENCE_TIMEOUT_MS;

    nowMs = START + PRESENCE_TIMEOUT_MS;
    await fireMachineAlarm();

    expect(machineRow(identity.machineId)?.status).toBe("offline");
    expect(sentTypes(daemonSocket)).toEqual(["hello_ack"]);
  });
  /** A person's socket, which also receives binary frames. */
  class ViewerSocket extends TaggedSocket {
    constructor() {
      super(["viewer"]);
    }

    messages() {
      return this.sent.map((raw) => JSON.parse(raw));
    }
  }

  const desktopHelloFrame = JSON.stringify({
    ...JSON.parse(computerHelloFrame),
    capabilities: {
      desktop: true,
      desktop_unavailable_reason: null,
      git: true,
      python3: true,
      skills: false,
    },
  });

  const dialViewer = async (
    identity: { machineId: string; workspaceId: string },
    userId: string
  ) => {
    await relay.connect("viewer", identity);
    const socket = new ViewerSocket();
    live.push(socket);
    relay.acceptViewer(socket, userId);
    await settleViewers();
    return socket;
  };

  /** Viewer pushes run in microtasks that wait on storage reads, so give them a turn of the event loop. */
  const settleViewers = async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await settle();
  };

  const input = JSON.stringify({
    actions: [{ type: "mouse_move", x: 10, y: 20 }],
    t: "input",
  });

  test("a viewer connecting changes nothing about the daemon or the computer", async () => {
    const identity = await enrolBoth();
    const daemonSocket = await dialDaemon(identity);
    await relay.message(daemonSocket, helloFrame);
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, computerHelloFrame);
    const generation = storage.values.get("computer:generation");

    const viewer = await dialViewer(identity, "user_1");

    expect(storage.values.get("computer:generation")).toBe(generation);
    expect(daemonSocket.closes).toEqual([]);
    expect(computerSocket.closes).toEqual([]);
    expect(viewer.closes).toEqual([]);

    await hangUp(viewer);
    expect(machineRow(identity.machineId)?.computerStatus).toBe("online");
    expect(relay.viewers.viewerCount).toBe(0);
  });

  test("a viewer is told the status, and again when a person takes the desktop", async () => {
    const identity = await enrolBoth();
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, desktopHelloFrame);

    const viewer = await dialViewer(identity, "user_1");
    expect(viewer.messages().at(-1)).toMatchObject({
      connected: true,
      desktop: true,
      t: "status",
      youHaveControl: false,
    });

    await relay.computer.takeHumanLease("user_1");
    await settleViewers();
    expect(viewer.messages().at(-1)).toMatchObject({
      t: "status",
      youHaveControl: true,
    });
  });

  test("a viewer's input is refused without the lease and sent to the computer once it holds it", async () => {
    const identity = await enrolBoth();
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, desktopHelloFrame);
    const viewer = await dialViewer(identity, "user_1");
    const sentOps = () =>
      computerSocket.sent.map((raw) => JSON.parse(raw).op as string);

    await relay.message(viewer, input);
    await settleViewers();
    expect(viewer.messages().at(-1)).toMatchObject({
      code: "lease_required",
      t: "error",
    });
    expect(sentOps()).not.toContain("desktop_input");

    await relay.computer.takeHumanLease("user_1");
    await relay.message(viewer, input);
    await settleViewers();
    expect(sentOps()).toContain("desktop_input");
  });

  test("the alarm takes viewers that outlived the object's memory back into the pump", async () => {
    const identity = await enrolBoth();
    const computerSocket = await dialComputer(identity);
    await relay.message(computerSocket, desktopHelloFrame);
    const viewer = await dialViewer(identity, "user_1");
    relay.viewers.close(viewer);
    expect(relay.viewers.viewerCount).toBe(0);

    await fireMachineAlarm();

    expect(relay.viewers.viewerCount).toBe(1);
  });
});
