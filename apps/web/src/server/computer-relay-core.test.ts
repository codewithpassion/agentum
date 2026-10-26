import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { migrated } from "@repo/db/test-db";
import {
  CLOSE_BAD_HELLO,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  ClientOpRequestSchema,
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  desktopInputTimeoutMs,
  MAX_IN_FLIGHT_EXEC,
  MAX_QUEUE_DEPTH,
  RELAY_GRACE_MS,
  STALE_AFTER_MS,
  STALENESS_POLL_MS,
} from "@repo/protocol/computer";
import { memoryFileBlobs } from "@repo/services/files/memory";
import type { ComputerPrincipal } from "@repo/services/machines/types";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { composeWith } from "./compose.ts";
import {
  AGENT_LEASE_IDLE_MS,
  createComputerRelayCore,
  FAILED_CLEARS_BEFORE_COMMANDS,
  HUMAN_LEASE_IDLE_MS,
  MAX_ORPHANS,
  PRESENCE_ALARM_MS,
  type Scheduler,
} from "./computer-relay-core.ts";
import type { RelaySocket, RelayStorage } from "./relay-core.ts";

const START = Date.parse("2026-10-16T09:30:00.000Z");
const ORG = "org_a";
const EXEC = { command: "ls", cwd: null, env: {}, timeout_ms: 5000 };
/** Long enough that the staleness poll, not the deadline, ends a request. */
const LONG_EXEC = { ...EXEC, timeout_ms: 60_000 };
const AGENT: ComputerPrincipal = { kind: "agent" };
const agent = (agentId: string): ComputerPrincipal => ({
  agentId,
  kind: "agent",
});
const person = (userId: string): ComputerPrincipal => ({
  kind: "human",
  userId,
});
const FrameSchema = z.record(z.string(), z.unknown());
type Frame = z.infer<typeof FrameSchema>;

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
    if (typeof data === "string") {
      this.sent.push(data);
    }
  }

  serializeAttachment(value: unknown) {
    this.attachment = value;
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

interface Timer {
  at: number;
  cancelled: boolean;
  every: number | null;
  run: () => void;
}

/** Timers that only fire when a test moves the clock with `advance`. */
class FakeScheduler implements Scheduler {
  private timers: Timer[] = [];

  after(ms: number, run: () => void) {
    return this.add({ at: nowMs + ms, every: null, run });
  }

  every(ms: number, run: () => void) {
    return this.add({ at: nowMs + ms, every: ms, run });
  }

  private add(timer: Omit<Timer, "cancelled">) {
    const entry: Timer = { ...timer, cancelled: false };
    this.timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Moves the clock forward, running each due callback in time order. */
  advance(ms: number) {
    const target = nowMs + ms;
    for (;;) {
      this.timers = this.timers.filter((timer) => !timer.cancelled);
      const [next] = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at);
      if (!next) {
        break;
      }
      nowMs = next.at;
      if (next.every === null) {
        next.cancelled = true;
      } else {
        next.at += next.every;
      }
      next.run();
    }
    nowMs = target;
  }
}

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

let nowMs: number;
let background: Promise<unknown>[];
let heartbeats: Map<FakeSocket, number>;
let ids: number;
let open: FakeSocket[];
let storage: FakeStorage;
let scheduler: FakeScheduler;
let db: ReturnType<typeof migrated>;
let services: ReturnType<typeof composeWith>["services"];
let user: Extract<Principal, { kind: "user" }>;
type TestCore = ReturnType<typeof buildCore>;
let core: TestCore;

const buildCore = (store: RelayStorage = storage, statusChanged?: () => void) =>
  createComputerRelayCore<FakeSocket>({
    background: (work) => {
      background.push(work);
    },
    heartbeatAt: (socket) => heartbeats.get(socket) ?? null,
    machines: services.machines,
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
    now: () => nowMs,
    scheduler,
    sockets: () => open,
    statusChanged,
    storage: store,
  });

beforeEach(async () => {
  db = migrated();
  nowMs = START;
  background = [];
  heartbeats = new Map();
  ids = 0;
  open = [];
  scheduler = new FakeScheduler();
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
  core = buildCore();
});

/** The v1 hello of a computer with a desktop, or without one. */
const hello = (desktop = true): string =>
  JSON.stringify({
    arch: "amd64",
    capabilities: {
      desktop,
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

/** Lets queued microtasks and background writes that can finish now, finish. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

/** Enrols a computer-only machine and returns the identity the Worker would stamp. */
const enrolComputer = async () => {
  const { code } = await services.machines.createEnrollToken(user, {
    machineName: "box",
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
    throw new Error("enroll returned null");
  }
  return { machineId: enrolled.machineId, workspaceId: user.workspaceId };
};

type Identity = Awaited<ReturnType<typeof enrolComputer>>;

/** The Worker's side of a connection: `connect`, then the runtime accepts the socket. */
const dial = async (identity: Identity) => {
  const { generation } = await core.connect(identity);
  const socket = new FakeSocket();
  open.push(socket);
  await core.accepted(socket, generation);
  return socket;
};

/** Enrols, dials and sends a hello. */
const connectOnline = async () => {
  const identity = await enrolComputer();
  const socket = await dial(identity);
  await core.message(socket, hello());
  return { identity, socket };
};

/** The socket closes: the runtime drops it, then the core hears of it. */
const hangUp = async (socket: FakeSocket) => {
  open.splice(open.indexOf(socket), 1);
  await core.closed(socket);
};

const answer = (socket: FakeSocket, id: string, result = {}) =>
  core.message(socket, JSON.stringify({ id, result }));

const answerError = (
  socket: FakeSocket,
  id: string,
  code: string,
  message = code
) => core.message(socket, JSON.stringify({ error: { code, message }, id }));

const frames = (socket: FakeSocket): Frame[] =>
  socket.sent.map((raw) => FrameSchema.parse(JSON.parse(raw)));

const opFrames = (socket: FakeSocket, op: string): Frame[] =>
  frames(socket).filter((frame) => frame.op === op);

/** The newest frame of an op, which a test is about to answer. */
const lastOp = (socket: FakeSocket, op: string): Frame => {
  const frame = opFrames(socket, op).at(-1);
  if (!frame) {
    throw new Error(`no ${op} frame was sent`);
  }
  return frame;
};

const idOf = (frame: Frame): string => String(frame.id);

/** A request the test starts without awaiting. Kept in `background` so a test can still await it. */
const fire = (promise: Promise<unknown>) => {
  background.push(promise);
};

/** Records what a promise settles to, so a test can see whether it has settled. */
const watch = <T>(promise: Promise<T>) => {
  const state: { value: T | null } = { value: null };
  fire(
    promise.then((value) => {
      state.value = value;
    })
  );
  return state;
};

const rowOf = (machineId: string) =>
  db.select().from(machines).where(eq(machines.id, machineId)).get();

const eventsOf = (type: "computer.online" | "computer.offline") =>
  db.select().from(events).where(eq(events.type, type)).all();

const closeCodes = (socket: FakeSocket) => socket.closes.map((c) => c.code);

const shot = (principal: ComputerPrincipal) =>
  core.desktopScreenshot(principal, { quality: null });

describe("hello and presence", () => {
  test("a hello marks the computer online with one computer.online event", async () => {
    const { identity } = await connectOnline();

    expect(rowOf(identity.machineId)?.computerStatus).toBe("online");
    expect(eventsOf("computer.online")).toHaveLength(1);
  });

  test("status reports what the hello said", async () => {
    await connectOnline();

    expect(await core.status()).toMatchObject({
      capabilities: {
        desktop: true,
        desktop_unavailable_reason: null,
        git: true,
        python3: true,
        skills: false,
      },
      connected: true,
      hostname: "box",
      version: "1.0.0",
      workdir: "/home/agent/sessions",
    });
  });

  test("a hello from a socket of an older generation is ignored", async () => {
    const identity = await enrolComputer();
    const old = await dial(identity);
    await dial(identity);

    await core.message(old, hello());

    expect((await core.status()).hostname).toBeNull();
    expect(rowOf(identity.machineId)?.computerStatus).toBe("offline");
    expect(eventsOf("computer.online")).toHaveLength(0);
  });

  test("an unreadable hello closes the socket 4400", async () => {
    const identity = await enrolComputer();
    const socket = await dial(identity);

    await core.message(socket, JSON.stringify({ type: "hello" }));

    expect(closeCodes(socket)).toEqual([CLOSE_BAD_HELLO]);
  });

  test("a hello from a revoked machine closes the socket 4401", async () => {
    const identity = await enrolComputer();
    await services.machines.revoke(user, identity.machineId);
    const socket = await dial(identity);

    await core.message(socket, hello());

    expect(closeCodes(socket)).toEqual([CLOSE_REVOKED]);
  });

  test("closing the last socket marks the computer offline with one computer.offline event", async () => {
    const { identity, socket } = await connectOnline();

    await hangUp(socket);

    expect(rowOf(identity.machineId)?.computerStatus).toBe("offline");
    expect(eventsOf("computer.offline")).toHaveLength(1);
  });

  test("closing a socket while a newer one is open leaves the computer online", async () => {
    const { identity, socket: first } = await connectOnline();
    await dial(identity);

    await hangUp(first);

    expect(rowOf(identity.machineId)?.computerStatus).toBe("online");
    expect(eventsOf("computer.offline")).toHaveLength(0);
  });

  test("the alarm with a fresh heartbeat refreshes last seen and re-arms the alarm", async () => {
    const { identity, socket } = await connectOnline();
    nowMs += PRESENCE_ALARM_MS;
    heartbeats.set(socket, nowMs);

    await core.alarm();

    expect(rowOf(identity.machineId)?.computerLastSeenAt).toBe(
      new Date(nowMs).toISOString()
    );
    expect(storage.alarm).toBe(nowMs + PRESENCE_ALARM_MS);
    expect(closeCodes(socket)).toEqual([]);
  });

  test("the alarm closes a socket silent for more than STALE_AFTER_MS and marks it offline", async () => {
    const { identity, socket } = await connectOnline();
    heartbeats.set(socket, START);
    nowMs = START + STALE_AFTER_MS + 1;

    await core.alarm();

    expect(closeCodes(socket)).toEqual([CLOSE_STALE]);
    expect(rowOf(identity.machineId)?.computerStatus).toBe("offline");
  });
});

describe("exec round trip and correlation", () => {
  test("exec sends one frame with a fresh id and resolves with the reply", async () => {
    const { socket } = await connectOnline();

    const pending = watch(core.exec(AGENT, EXEC));
    await settle();
    expect(opFrames(socket, "exec")).toEqual([
      { ...EXEC, id: "id-1", op: "exec" },
    ]);

    await answer(socket, "id-1", { exit_code: 0, stdout: "a.txt\n" });
    await settle();
    expect(pending.value).toEqual({
      ok: true,
      resultJson: JSON.stringify({ exit_code: 0, stdout: "a.txt\n" }),
    });
  });

  test("two requests answered out of order each get their own reply", async () => {
    const { socket } = await connectOnline();
    const first = watch(core.exec(AGENT, EXEC));
    const second = watch(core.exec(AGENT, { ...EXEC, command: "pwd" }));
    await settle();
    expect(opFrames(socket, "exec").map(idOf)).toEqual(["id-1", "id-2"]);

    await answer(socket, "id-2", { stdout: "two" });
    await answer(socket, "id-1", { stdout: "one" });
    await settle();

    expect(first.value).toEqual({
      ok: true,
      resultJson: JSON.stringify({ stdout: "one" }),
    });
    expect(second.value).toEqual({
      ok: true,
      resultJson: JSON.stringify({ stdout: "two" }),
    });
  });

  test("an error reply becomes a client_error carrying the code", async () => {
    const { socket } = await connectOnline();
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();

    await answerError(socket, "id-1", "not_found", "no such file");
    await settle();

    expect(pending.value).toEqual({
      code: "not_found",
      message: "no such file",
      ok: false,
      reason: "client_error",
    });
  });

  test("a reply from a socket other than the one the request went out on is ignored", async () => {
    const { socket } = await connectOnline();
    const intruder = new FakeSocket();
    open.push(intruder);
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();

    await answer(intruder, "id-1", { stdout: "forged" });
    await settle();
    expect(pending.value).toBeNull();

    await answer(socket, "id-1", { stdout: "real" });
    await settle();
    expect(pending.value).toEqual({
      ok: true,
      resultJson: JSON.stringify({ stdout: "real" }),
    });
  });

  test("no socket answers offline with a message naming the computer", async () => {
    const { socket } = await connectOnline();
    await hangUp(socket);

    expect(await core.exec(AGENT, EXEC)).toMatchObject({
      message: expect.stringContaining("Computer box is offline"),
      ok: false,
      reason: "offline",
    });
  });

  test("a request with no answer fails timeout once timeout_ms plus the grace has passed", async () => {
    await connectOnline();
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();
    const deadline = EXEC.timeout_ms + RELAY_GRACE_MS;

    scheduler.advance(deadline - 1);
    await settle();
    expect(pending.value).toBeNull();

    scheduler.advance(1);
    await settle();
    expect(pending.value).toMatchObject({ ok: false, reason: "timeout" });
  });

  test("a request whose id is already in flight fails duplicate_id and the first stays pending", async () => {
    const { socket } = await connectOnline();
    const first = watch(
      core.request({ ...EXEC, id: "dup", op: "exec" }, AGENT)
    );
    await settle();

    expect(
      await core.request({ ...EXEC, id: "dup", op: "exec" }, AGENT)
    ).toMatchObject({
      ok: false,
      reason: "duplicate_id",
    });
    expect(first.value).toBeNull();
    expect(opFrames(socket, "exec")).toHaveLength(1);
  });
});

describe("in-flight cap", () => {
  test("a fifth exec waits for a slot and sends nothing until one is answered", async () => {
    const { socket } = await connectOnline();
    const calls = Array.from({ length: MAX_IN_FLIGHT_EXEC + 1 }, () =>
      watch(core.exec(AGENT, EXEC))
    );
    await settle();

    expect(opFrames(socket, "exec")).toHaveLength(MAX_IN_FLIGHT_EXEC);
    expect(await core.status()).toMatchObject({
      inFlightExec: MAX_IN_FLIGHT_EXEC,
      queued: 1,
    });

    await answer(socket, "id-1");
    await settle();

    expect(opFrames(socket, "exec").map(idOf)).toEqual([
      "id-1",
      "id-2",
      "id-3",
      "id-4",
      "id-5",
    ]);
    expect(await core.status()).toMatchObject({
      inFlightExec: MAX_IN_FLIGHT_EXEC,
      queued: 0,
    });
    expect(calls.at(-1)?.value).toBeNull();
  });

  test("an exec beyond the queue depth is refused queue_full at once", async () => {
    await connectOnline();
    const accepted = MAX_IN_FLIGHT_EXEC + MAX_QUEUE_DEPTH;
    for (let n = 0; n < accepted; n += 1) {
      core.exec(AGENT, EXEC);
    }
    await settle();

    expect(await core.exec(AGENT, EXEC)).toMatchObject({
      ok: false,
      reason: "queue_full",
    });
    expect((await core.status()).queued).toBe(MAX_QUEUE_DEPTH);
  });

  test("in-flight and queued counts return to zero once every command is answered", async () => {
    const { socket } = await connectOnline();
    const accepted = MAX_IN_FLIGHT_EXEC + MAX_QUEUE_DEPTH;
    const calls = Array.from({ length: accepted }, () =>
      watch(core.exec(AGENT, EXEC))
    );
    await settle();

    for (let n = 1; n <= accepted; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each answer frees a slot the next command needs
      await answer(socket, `id-${n}`);
      await settle();
    }

    expect(opFrames(socket, "exec")).toHaveLength(accepted);
    expect(calls.every((call) => call.value?.ok === true)).toBe(true);
    expect(await core.status()).toMatchObject({ inFlightExec: 0, queued: 0 });
  });
});

describe("stale socket and connection loss", () => {
  test("a pending request on a stale socket fails stale at the poll and the socket closes 4408", async () => {
    const { socket } = await connectOnline();
    heartbeats.set(socket, START);
    const pending = watch(core.exec(AGENT, LONG_EXEC));
    await settle();

    scheduler.advance(STALE_AFTER_MS - STALENESS_POLL_MS);
    await settle();
    expect(pending.value).toBeNull();
    expect(closeCodes(socket)).toEqual([]);

    scheduler.advance(2 * STALENESS_POLL_MS);
    await settle();
    expect(pending.value).toMatchObject({ ok: false, reason: "stale" });
    expect(closeCodes(socket)).toEqual([CLOSE_STALE]);
  });

  test("closing the socket fails its pending request interrupted", async () => {
    const { socket } = await connectOnline();
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();

    await hangUp(socket);
    await settle();

    expect(pending.value).toMatchObject({ ok: false, reason: "interrupted" });
  });
});

describe("replace", () => {
  test("a second connect closes the old socket 4409 and fails what was pending on it replaced", async () => {
    const { identity, socket: old } = await connectOnline();
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();

    await dial(identity);
    await settle();

    expect(closeCodes(old)).toEqual([CLOSE_REPLACED]);
    expect(pending.value).toMatchObject({ ok: false, reason: "replaced" });
  });

  test("a reply on the old socket is ignored and the new socket's reply counts", async () => {
    const { identity, socket: old } = await connectOnline();
    const fresh = await dial(identity);
    await core.message(fresh, hello());
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();
    expect(opFrames(fresh, "exec").map(idOf)).toEqual(["id-1"]);

    await answer(old, "id-1", { stdout: "stale" });
    await settle();
    expect(pending.value).toBeNull();

    await answer(fresh, "id-1", { stdout: "fresh" });
    await settle();
    expect(pending.value).toEqual({
      ok: true,
      resultJson: JSON.stringify({ stdout: "fresh" }),
    });
    expect((await core.status()).connected).toBe(true);
  });
});

describe("revoke", () => {
  test("revoke closes every computer socket 4401 and fails pending requests revoked", async () => {
    const { socket: first } = await connectOnline();
    const second = new FakeSocket();
    open.push(second);
    const pending = watch(core.exec(AGENT, EXEC));
    await settle();

    core.revoke();
    await settle();

    expect(closeCodes(first)).toEqual([CLOSE_REVOKED]);
    expect(closeCodes(second)).toEqual([CLOSE_REVOKED]);
    expect(pending.value).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("orphans", () => {
  test("a timed-out request's id is cancelled on the next socket", async () => {
    const { identity } = await connectOnline();
    fire(core.exec(AGENT, EXEC));
    await settle();
    scheduler.advance(EXEC.timeout_ms + RELAY_GRACE_MS);
    await settle();

    const next = await dial(identity);
    await settle();

    expect(opFrames(next, "cancel").map((f) => f.target_id)).toEqual(["id-1"]);
  });

  test("an interrupted request's id is cancelled on the next socket", async () => {
    const { identity, socket } = await connectOnline();
    fire(core.exec(AGENT, EXEC));
    await settle();
    await hangUp(socket);

    const next = await dial(identity);
    await settle();

    expect(opFrames(next, "cancel").map((f) => f.target_id)).toEqual(["id-1"]);
  });

  test("the cancel list is cleared once it has been sent", async () => {
    const { identity, socket } = await connectOnline();
    fire(core.exec(AGENT, EXEC));
    await settle();
    await hangUp(socket);
    await dial(identity);
    await settle();

    const later = await dial(identity);
    await settle();

    expect(opFrames(later, "cancel")).toEqual([]);
  });

  test("at most MAX_ORPHANS ids are kept and the oldest are dropped", async () => {
    const { identity, socket } = await connectOnline();
    const total = MAX_ORPHANS + 1;
    for (let n = 0; n < total; n += 1) {
      // file_get is not capped like exec, so every request is in flight at once.
      fire(core.fileGet(AGENT, { max_bytes: 1, offset: 0, path: "/f" }));
    }
    await settle();
    await hangUp(socket);
    await settle();

    const next = await dial(identity);
    await settle();

    const targets = opFrames(next, "cancel").map((f) => f.target_id);
    expect(targets).toHaveLength(MAX_ORPHANS);
    expect(targets[0]).toBe("id-2");
    expect(targets.at(-1)).toBe(`id-${total}`);
  });
});

describe("desktop lease", () => {
  test("desktop ops are refused desktop_unavailable when the hello said there is no desktop", async () => {
    const identity = await enrolComputer();
    const socket = await dial(identity);
    await core.message(socket, hello(false));

    expect(await shot(agent("a1"))).toMatchObject({
      ok: false,
      reason: "desktop_unavailable",
    });
    expect(opFrames(socket, "desktop_screenshot")).toEqual([]);
  });

  test("the first agent desktop op takes the lease, and another agent is refused desktop_busy", async () => {
    const { socket } = await connectOnline();
    fire(shot(agent("a1")));
    await settle();

    expect(await core.status()).toMatchObject({
      control: { holder: { agentId: "a1", kind: "agent" } },
    });
    expect(await shot(agent("a2"))).toMatchObject({
      ok: false,
      reason: "desktop_busy",
    });
    expect(opFrames(socket, "desktop_screenshot")).toHaveLength(1);
  });

  test("takeHumanLease preempts the agent, whose exec is refused human_in_control", async () => {
    const { socket } = await connectOnline();
    fire(shot(agent("a1")));
    await settle();

    expect(await core.takeHumanLease("u1")).toMatchObject({
      control: { holder: { kind: "human", userId: "u1" } },
      ok: true,
    });
    expect(await shot(agent("a1"))).toMatchObject({
      reason: "human_in_control",
    });
    expect(await core.exec(agent("a1"), EXEC)).toMatchObject({
      reason: "human_in_control",
    });

    // cancel always goes through, so a running command can still be stopped.
    fire(core.request({ op: "cancel", target_id: "id-1" }, agent("a1")));
    await settle();
    expect(opFrames(socket, "cancel")).toHaveLength(1);
  });

  test("a second person is refused human_in_control for input", async () => {
    await connectOnline();
    await core.takeHumanLease("u1");

    expect(
      await core.desktopInput(person("u2"), {
        actions: [{ keys: "Return", type: "key" }],
      })
    ).toMatchObject({ reason: "human_in_control" });
  });

  test("a second person's takeHumanLease clears the clipboard first and waits for the clear", async () => {
    const { socket } = await connectOnline();
    await core.takeHumanLease("u1");
    const second = watch(core.takeHumanLease("u2"));
    await settle();

    expect(lastOp(socket, "desktop_clipboard_set")).toMatchObject({
      selections: ["clipboard", "primary"],
      text: "",
    });
    expect(second.value).toBeNull();

    await answer(socket, idOf(lastOp(socket, "desktop_clipboard_set")));
    await settle();

    expect(second.value).toMatchObject({
      control: { holder: { kind: "human", userId: "u2" } },
      ok: true,
    });
  });

  test("releaseHumanLease clears the clipboard, and agent ops wait for the clear", async () => {
    const { socket } = await connectOnline();
    await core.takeHumanLease("u1");
    const release = watch(core.releaseHumanLease("u1"));
    await settle();

    expect(lastOp(socket, "desktop_clipboard_set")).toMatchObject({ text: "" });
    expect(await shot(agent("a1"))).toMatchObject({ reason: "desktop_busy" });
    expect(await core.exec(agent("a1"), EXEC)).toMatchObject({
      reason: "desktop_busy",
    });

    await answer(socket, idOf(lastOp(socket, "desktop_clipboard_set")));
    await settle();
    expect(release.value).toEqual({ clipboardCleared: true, released: true });

    fire(shot(agent("a1")));
    await settle();
    expect(opFrames(socket, "desktop_screenshot")).toHaveLength(1);
  });

  test("a person may screenshot without the lease, but input without it and a person's exec are forbidden", async () => {
    const { socket } = await connectOnline();

    fire(core.desktopScreenshot(person("u9"), { quality: null }));
    await settle();
    expect(opFrames(socket, "desktop_screenshot")).toHaveLength(1);
    expect(
      await core.desktopInput(person("u9"), {
        actions: [{ keys: "Return", type: "key" }],
      })
    ).toMatchObject({ reason: "forbidden" });
    expect(await core.exec(person("u9"), EXEC)).toMatchObject({
      reason: "forbidden",
    });
  });

  test("after FAILED_CLEARS_BEFORE_COMMANDS failed clears the agent's exec runs, but desktop ops stay refused", async () => {
    const { socket } = await connectOnline();
    await core.takeHumanLease("u1");
    const release = watch(core.releaseHumanLease("u1"));
    await settle();

    for (let n = 0; n < FAILED_CLEARS_BEFORE_COMMANDS; n += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each failed clear is answered before the next one is sent
      await answerError(
        socket,
        idOf(lastOp(socket, "desktop_clipboard_set")),
        "failed"
      );
      await settle();
      if (n < FAILED_CLEARS_BEFORE_COMMANDS - 1) {
        await core.exec(agent("a1"), EXEC);
        await settle();
      }
    }
    expect(release.value).toEqual({ clipboardCleared: false, released: true });

    const run = watch(core.exec(agent("a1"), EXEC));
    await settle();
    expect(opFrames(socket, "exec")).toHaveLength(1);
    expect(run.value).toBeNull();
    expect(await shot(agent("a1"))).toMatchObject({ reason: "desktop_busy" });
  });

  test("an agent lease idle for AGENT_LEASE_IDLE_MS is let go", async () => {
    const { socket } = await connectOnline();
    fire(shot(agent("a1")));
    await settle();

    nowMs += AGENT_LEASE_IDLE_MS - 1;
    await core.alarm();
    expect((await core.status()).control).not.toBeNull();

    nowMs += 1;
    await core.alarm();
    expect((await core.status()).control).toBeNull();
    fire(shot(agent("a2")));
    await settle();
    expect(opFrames(socket, "desktop_screenshot")).toHaveLength(2);
  });

  test("a person idle for HUMAN_LEASE_IDLE_MS leaves the desktop clearing", async () => {
    const { socket } = await connectOnline();
    await core.takeHumanLease("u1");

    nowMs += HUMAN_LEASE_IDLE_MS;
    await core.alarm();
    await settle();

    expect(lastOp(socket, "desktop_clipboard_set")).toMatchObject({ text: "" });
    expect((await core.status()).control).toBeNull();
    expect(await shot(agent("a1"))).toMatchObject({ reason: "desktop_busy" });
  });

  test("a lease survives a new core built on the same storage", async () => {
    await connectOnline();
    await core.takeHumanLease("u1");
    const restarted = buildCore(storage);

    expect(await restarted.status()).toMatchObject({
      control: { holder: { kind: "human", userId: "u1" } },
    });
    expect(
      await restarted.desktopScreenshot(agent("a1"), { quality: null })
    ).toMatchObject({ reason: "human_in_control" });
  });

  test("an exec queued behind the cap is refused when a person takes the desktop before it is sent", async () => {
    const { socket } = await connectOnline();
    for (let n = 0; n < MAX_IN_FLIGHT_EXEC; n += 1) {
      fire(core.exec(AGENT, EXEC));
    }
    const queued = watch(core.exec(agent("a1"), EXEC));
    await settle();

    await core.takeHumanLease("u1");
    await answer(socket, "id-1");
    await settle();

    expect(queued.value).toMatchObject({
      ok: false,
      reason: "human_in_control",
    });
    expect(opFrames(socket, "exec")).toHaveLength(MAX_IN_FLIGHT_EXEC);
  });
});

describe("typed wrappers", () => {
  test("filePut sends a file_put frame with its fields", async () => {
    const { socket } = await connectOnline();
    const input = {
      data_b64: "aGk=",
      final: true,
      path: "/home/agent/sessions/a.txt",
      seq: 0,
      sha256: null,
      transfer_id: "t1",
    };

    fire(core.filePut(AGENT, input));
    await settle();

    const frame = lastOp(socket, "file_put");
    expect(ClientOpRequestSchema.parse(frame)).toEqual({
      ...input,
      op: "file_put",
    });
  });

  test("fileGet sends a file_get frame with its fields", async () => {
    const { socket } = await connectOnline();
    const input = { max_bytes: 1024, offset: 0, path: "/home/agent/a.txt" };

    fire(core.fileGet(AGENT, input));
    await settle();

    const frame = lastOp(socket, "file_get");
    expect(ClientOpRequestSchema.parse(frame)).toEqual({
      ...input,
      op: "file_get",
    });
  });

  test("desktopScreenshot sends its quality and the screenshot timeout", async () => {
    const { socket } = await connectOnline();

    fire(core.desktopScreenshot(AGENT, { quality: 60 }));
    await settle();

    const frame = lastOp(socket, "desktop_screenshot");
    expect(ClientOpRequestSchema.parse(frame)).toEqual({
      op: "desktop_screenshot",
      quality: 60,
    });
    expect(frame.timeout_ms).toBe(DESKTOP_SCREENSHOT_TIMEOUT_MS);
  });

  test("desktopInput sends its actions and the timeout for them", async () => {
    const { socket } = await connectOnline();
    const actions = [
      { text: "hello", type: "type" as const },
      {
        button: "left" as const,
        count: 1,
        type: "click" as const,
        x: 10,
        y: 20,
      },
    ];

    fire(core.desktopInput(AGENT, { actions }));
    await settle();

    const frame = lastOp(socket, "desktop_input");
    expect(ClientOpRequestSchema.parse(frame)).toEqual({
      actions,
      op: "desktop_input",
    });
    expect(frame.timeout_ms).toBe(desktopInputTimeoutMs(actions));
  });

  test("clipboardGet sends a clipboard get with the clipboard timeout", async () => {
    const { socket } = await connectOnline();

    fire(core.clipboardGet(AGENT));
    await settle();

    const frame = lastOp(socket, "desktop_clipboard_get");
    expect(ClientOpRequestSchema.parse(frame)).toEqual({
      op: "desktop_clipboard_get",
    });
    expect(frame.timeout_ms).toBe(DESKTOP_CLIPBOARD_TIMEOUT_MS);
  });

  test("clipboardSet sends its selections and text with the clipboard timeout", async () => {
    const { socket } = await connectOnline();

    fire(core.clipboardSet(AGENT, { selections: ["primary"], text: "hi" }));
    await settle();

    const frame = lastOp(socket, "desktop_clipboard_set");
    expect(ClientOpRequestSchema.parse(frame)).toEqual({
      op: "desktop_clipboard_set",
      selections: ["primary"],
      text: "hi",
    });
    expect(frame.timeout_ms).toBe(DESKTOP_CLIPBOARD_TIMEOUT_MS);
  });
});

describe("status hook", () => {
  let calls: number;

  beforeEach(() => {
    calls = 0;
    core = buildCore(storage, () => {
      calls += 1;
    });
  });

  test("the hook fires when a hello arrives", async () => {
    const identity = await enrolComputer();
    const socket = await dial(identity);
    const before = calls;

    await core.message(socket, hello());

    expect(calls).toBeGreaterThan(before);
  });

  test("the hook fires when a person takes the desktop and when they release it", async () => {
    const { socket } = await connectOnline();
    const beforeTake = calls;
    await core.takeHumanLease("u1");
    expect(calls).toBeGreaterThan(beforeTake);

    const beforeRelease = calls;
    const release = watch(core.releaseHumanLease("u1"));
    await settle();
    await answer(socket, idOf(lastOp(socket, "desktop_clipboard_set")));
    await settle();

    expect(release.value).toEqual({ clipboardCleared: true, released: true });
    expect(calls).toBeGreaterThan(beforeRelease);
  });

  test("the hook fires when the computer's socket closes", async () => {
    const { socket } = await connectOnline();
    const before = calls;

    await hangUp(socket);

    expect(calls).toBeGreaterThan(before);
  });

  test("a hook that throws does not break the call", async () => {
    const logged = console.error;
    console.error = () => undefined;
    try {
      core = buildCore(storage, () => {
        throw new Error("viewer hub is down");
      });
      const { socket } = await connectOnline();

      expect(await core.takeHumanLease("u1")).toMatchObject({
        control: { holder: { kind: "human", userId: "u1" } },
        ok: true,
      });
      await hangUp(socket);
      expect(open).toHaveLength(0);
    } finally {
      console.error = logged;
    }
  });
});
