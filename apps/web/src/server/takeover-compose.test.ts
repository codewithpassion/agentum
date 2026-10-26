import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { TAKEOVER_TTL_MS } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import {
  type ComputerControl,
  type ComputerStatus,
  type MachineRelayPort,
  noopRelay,
  type TakeHumanLeaseOutcome,
} from "@repo/services/machines/types";
import { type Clock, systemClock } from "@repo/services/runs/types";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { type Composed, composeWith } from "./compose.ts";

// The takeover service is built in compose.ts with the machine relay as its
// desktop lease. These tests run the real services over a relay that records
// what it is asked, so they cover the wiring, not the relay.

type User = Extract<Principal, { kind: "user" }>;

const HOLDER = "holder_1";

let db: ReturnType<typeof migrated>;
let composed: Composed;
let user: User;
let machineId: string;
let requestId: string;
let calls: unknown[][];
let control: ComputerControl | null;
let takeOutcome: TakeHumanLeaseOutcome;

const status = (): ComputerStatus => ({
  capabilities: null,
  connected: true,
  control,
  hostname: null,
  inFlightExec: 0,
  lastSeenAt: null,
  queued: 0,
  version: null,
  workdir: null,
});

const relay: MachineRelayPort = {
  ...noopRelay,
  computerStatus: () => Promise.resolve(status()),
  releaseHumanLease: (...args) => {
    calls.push(["release", ...args]);
    return Promise.resolve({ clipboardCleared: true, released: true });
  },
  takeHumanLease: (...args) => {
    calls.push(["take", ...args]);
    return Promise.resolve(takeOutcome);
  },
};

const composeAt = (clock: Clock): Composed => {
  const store = new Map<string, string>();
  return composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock,
      cloudRunner: {
        cancel: () => Promise.resolve(),
        libraryChanged: () => Promise.resolve(),
        start: () => Promise.resolve(),
      },
      devFakeRuntime: false,
      fileBlobs: memoryFileBlobs(),
      publicBaseUrl: "https://hm.test",
      relay,
      runTokenKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    },
  });
};

beforeEach(async () => {
  db = migrated();
  calls = [];
  control = null;
  takeOutcome = {
    control: { expiresAt: 1, holder: { kind: "human", userId: "user_a" } },
    ok: true,
  };
  composed = composeAt(systemClock);
  const { services } = composed;
  const workspace = await services.workspaces.forOrg({ clerkOrgId: "org_a" });
  if (!workspace) {
    throw new Error("org_a must be allowed");
  }
  user = {
    kind: "user",
    userId: "user_a",
    via: "session",
    workspaceId: workspace.id,
  };
  const { code } = await services.machines.createEnrollToken(user, {
    machineName: "desk",
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
  ({ machineId } = enrolled);
  const agent = await services.agents.create(user, {
    model: "m",
    name: "Cloud",
    runtime: "cloud",
  });
  await services.machines.attachComputer(user, agent.id, machineId);
  const run = await services.runs.startRun(user, {
    agentId: agent.id,
    input: { text: "go" },
    session: { origin: "ui" },
  });
  await services.runs.claimRun(SYSTEM_PRINCIPAL, run.runId);
  const request = await services.requests.open(SYSTEM_PRINCIPAL, {
    kind: "takeover",
    reason: "Log in",
    runId: run.runId,
    toolUseId: "takeover",
  });
  requestId = request.id;
});

test("taking control gives the desktop to the person through the relay", async () => {
  await composed.services.takeover.take(user, requestId);
  expect(calls).toEqual([["take", machineId, "user_a"]]);
});

test("a refused take is a conflict that carries the relay's reason and logs no take", async () => {
  takeOutcome = {
    message: "The desktop is being cleared.",
    ok: false,
    reason: "desktop_busy",
  };
  await expect(
    composed.services.takeover.take(user, requestId)
  ).rejects.toMatchObject({
    code: "conflict",
    message: "The desktop is being cleared.",
  });
  const events = await composed.services.events.query(
    user,
    user.workspaceId,
    {}
  );
  expect(events.map((event) => event.type)).not.toContain("computer.taken");
});

test("handing back releases the person who holds the desktop, even when another hands back", async () => {
  control = { expiresAt: 1, holder: { kind: "human", userId: HOLDER } };
  await composed.services.takeover.handBack(user, requestId, "done");
  expect(calls).toEqual([["release", machineId, HOLDER]]);
});

test("cancelling releases the holder", async () => {
  control = { expiresAt: 1, holder: { kind: "human", userId: HOLDER } };
  await composed.services.takeover.cancel(user, requestId);
  expect(calls).toContainEqual(["release", machineId, HOLDER]);
});

test("a takeover that expires releases the desktop", async () => {
  control = { expiresAt: 1, holder: { kind: "human", userId: HOLDER } };
  const later = composeAt({
    now: () => new Date(Date.now() + TAKEOVER_TTL_MS + 1000),
    sleep: () => Promise.resolve(),
  });
  await later.services.requests.expireDue(SYSTEM_PRINCIPAL);
  expect(calls).toEqual([["release", machineId, HOLDER]]);
});

test("a desktop nobody holds is not released", async () => {
  await composed.services.takeover.cancel(user, requestId);
  expect(calls).toEqual([]);
});

test("take then hand-back runs the whole flow through the relay", async () => {
  const { takeover } = composed.services;
  await takeover.take(user, requestId);
  control = { expiresAt: 1, holder: { kind: "human", userId: "user_a" } };
  await takeover.handBack(user, requestId, "done");
  expect(calls).toEqual([
    ["take", machineId, "user_a"],
    ["release", machineId, "user_a"],
  ]);
  const events = await composed.services.events.query(
    user,
    user.workspaceId,
    {}
  );
  const types = events.map((event) => event.type);
  expect(types).toContain("computer.taken");
  expect(types).toContain("computer.handed_back");
});
