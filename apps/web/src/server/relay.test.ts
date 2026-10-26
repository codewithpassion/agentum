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

  send(data: string) {
    this.sent.push(data);
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
  db = migrated();
  nowMs = START;
  open = [];
  storage = new FakeStorage();
  const blobs = new Map<string, string>();
  ({ services } = composeWith({
    allowedOrgIds: [ORG],
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
    expect(JSON.parse(row?.capabilities ?? "{}")).toEqual({
      agentSdk: "0.2.0",
      container: false,
      daemonVersion: "0.1.0",
    });
    expect(machineEvents().map((event) => event.type)).toEqual([
      "machine.online",
    ]);
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
