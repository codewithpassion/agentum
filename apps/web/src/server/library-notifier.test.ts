import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import type { MachineRelayPort } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { type Composed, composeWith } from "./compose.ts";

const ORG = "org_a";
const bytes = (text: string) => new TextEncoder().encode(text);

type User = Extract<Principal, { kind: "user" }>;
interface Announced {
  machineId: string;
  paths: string[];
}
interface Pulled {
  paths: string[];
  sessionId: string;
}

let db: ReturnType<typeof migrated>;
let composed: Composed;
let user: User;
let announced: Announced[];
let pulled: Pulled[];
let deferred: Promise<void>[];
let failRelay: boolean;
let useDefer: boolean;

const relay = (): MachineRelayPort => ({
  announce: (machineId, paths) => {
    if (failRelay) {
      return Promise.reject(new Error("relay down"));
    }
    announced.push({ machineId, paths });
    return Promise.resolve();
  },
  cancel: () => Promise.resolve(),
  offer: () => Promise.resolve(),
  revoke: () => Promise.resolve(),
});

const compose = () => {
  composed = composeWith({
    allowedOrgIds: [ORG],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      clock: systemClock,
      cloudRunner: {
        cancel: () => Promise.resolve(),
        libraryChanged: (sessionId, paths) => {
          pulled.push({ paths, sessionId });
          return Promise.resolve();
        },
        start: () => Promise.resolve(),
      },
      defer: useDefer ? (work) => deferred.push(work) : undefined,
      devFakeRuntime: false,
      fileBlobs: memoryFileBlobs(),
      publicBaseUrl: "https://hm.test",
      relay: relay(),
      runTokenKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    },
  });
};

beforeEach(async () => {
  db = migrated();
  announced = [];
  pulled = [];
  deferred = [];
  failRelay = false;
  useDefer = false;
  compose();
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: ORG,
  });
  if (!workspace) {
    throw new Error("The organisation must be allowed");
  }
  user = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId: workspace.id,
  };
});

const enrol = async (name: string) => {
  const { code } = await composed.services.machines.createEnrollToken(user, {
    machineName: name,
  });
  const enrolled = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  return enrolled.machineId;
};

/** Starts a run of the agent and marks it running, claimed by `claimedBy` when given. */
const runningRun = async (agentId: string, claimedBy: string | null) => {
  const run = await composed.services.runs.startRun(user, {
    agentId,
    input: { text: "hi" },
    session: { origin: "ui" },
  });
  db.update(runRows)
    .set({ claimedBy, status: "running" })
    .where(eq(runRows.id, run.runId))
    .run();
  return run;
};

const machineAgent = async (name: string) => {
  const machineId = await enrol(name);
  const agent = await composed.services.agents.create(user, {
    machineId,
    model: "m",
    name,
    runtime: "machine",
  });
  return { agent, machineId, run: await runningRun(agent.id, machineId) };
};

const cloudAgent = async (name: string, environment: string) => {
  const agent = await composed.services.agents.create(user, {
    model: "m",
    name,
    runtime: "cloud",
    runtimeConfig: { environment },
  });
  return { agent, run: await runningRun(agent.id, null) };
};

describe("library notifier", () => {
  test("a covered machine run gets one frame and an uncovered one none", async () => {
    const ada = await machineAgent("ada");
    await machineAgent("bob");

    await composed.services.library.write(
      user,
      `agents/${ada.agent.slug}/notes.md`,
      bytes("hi")
    );

    expect(announced).toEqual([
      {
        machineId: ada.machineId,
        paths: [`agents/${ada.agent.slug}/notes.md`],
      },
    ]);
  });

  test("the wiki is covered for every machine", async () => {
    const ada = await machineAgent("ada");
    const bob = await machineAgent("bob");

    await composed.services.library.write(user, "wiki/index.md", bytes("hi"));

    expect(announced.map((a) => a.machineId).toSorted()).toEqual(
      [ada.machineId, bob.machineId].toSorted()
    );
  });

  test("a run that wrote the change does not hear about it", async () => {
    const ada = await machineAgent("ada");

    await composed.services.library.write(
      {
        agentId: ada.agent.id,
        kind: "run",
        runId: ada.run.runId,
        workspaceId: user.workspaceId,
      },
      `agents/${ada.agent.slug}/out.md`,
      bytes("hi")
    );

    expect(announced).toEqual([]);
  });

  test("a run waiting on a person still hears about changes", async () => {
    const ada = await machineAgent("ada");
    db.update(runRows)
      .set({ status: "waiting" })
      .where(eq(runRows.id, ada.run.runId))
      .run();

    await composed.services.library.write(user, "wiki/index.md", bytes("hi"));

    expect(announced.map((a) => a.machineId)).toEqual([ada.machineId]);
  });

  test("a run that is not running hears nothing", async () => {
    const ada = await machineAgent("ada");
    db.update(runRows)
      .set({ status: "done" })
      .where(eq(runRows.id, ada.run.runId))
      .run();

    await composed.services.library.write(user, "wiki/index.md", bytes("hi"));

    expect(announced).toEqual([]);
  });

  test("a VM run gets the RPC and an isolate run does not", async () => {
    const vm = await cloudAgent("vm", "linux-vm");
    await cloudAgent("iso", "isolate");

    await composed.services.library.write(user, "wiki/index.md", bytes("hi"));

    expect(pulled).toEqual([
      { paths: ["wiki/index.md"], sessionId: vm.run.sessionId },
    ]);
    expect(announced).toEqual([]);
  });

  test("a failing relay does not fail the write or stop the VM run hearing", async () => {
    await machineAgent("ada");
    const vm = await cloudAgent("vm", "linux-vm");
    failRelay = true;
    const errors = console.error;
    console.error = () => undefined;
    try {
      await composed.services.library.write(user, "wiki/index.md", bytes("hi"));
    } finally {
      console.error = errors;
    }

    expect(pulled.map((entry) => entry.sessionId)).toEqual([vm.run.sessionId]);
  });

  test("with defer, the write returns first and the announcement follows", async () => {
    useDefer = true;
    compose();
    const ada = await machineAgent("ada");

    await composed.services.library.write(user, "wiki/index.md", bytes("hi"));
    expect(announced).toEqual([]);
    expect(deferred).toHaveLength(1);

    await Promise.all(deferred);
    expect(announced).toEqual([
      { machineId: ada.machineId, paths: ["wiki/index.md"] },
    ]);
  });
});
