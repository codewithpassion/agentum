import { expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "@repo/services/agents";
import { mintEnrollCode } from "./enroll-token.ts";
import { devUserPrincipal, localEvents, localMachines } from "./local.ts";
import { describeMachines } from "./machines.ts";
import { localRuns, startMachineRun } from "./start-machine-run.ts";

const ORG = "org_dev";
const MACHINE_NAME = "dev-laptop";

/** Mints a code and enrols a machine with it. Returns the machine id. */
const enrollMachine = async (
  db: ReturnType<typeof migrated>,
  name = MACHINE_NAME
): Promise<string> => {
  const code = await mintEnrollCode({ db, machineName: name, orgId: ORG });
  const enrolled = await localMachines(db, ORG).enroll({
    code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("The machines service refused the code.");
  }
  return enrolled.machineId;
};

test("mintEnrollCode returns a code the machines service enrols once", async () => {
  const db = migrated();
  const code = await mintEnrollCode({
    db,
    machineName: MACHINE_NAME,
    orgId: ORG,
  });
  expect(code.startsWith("hm_enr_")).toBe(true);

  const machines = localMachines(db, ORG);
  const enrolled = await machines.enroll({ code, singleUser: false });
  expect(enrolled?.machineId).toBeString();
  expect(await machines.enroll({ code, singleUser: false })).toBeNull();
});

test("describeMachines shows an empty database as empty", async () => {
  const db = migrated();
  const text = await describeMachines(db, ORG);
  expect(text).toContain("No machines.");
  expect(text).toContain("No machine events.");
});

test("describeMachines lists an enrolled machine as offline", async () => {
  const db = migrated();
  const machineId = await enrollMachine(db);
  const text = await describeMachines(db, ORG);
  expect(text).toContain(machineId);
  expect(text).toContain(MACHINE_NAME);
  expect(text).toContain("offline");
  expect(text).toContain("last_seen_at=never");
  expect(text).toContain("No machine events.");
});

test("describeMachines lists the presence events of a machine", async () => {
  const db = migrated();
  const machineId = await enrollMachine(db);
  const { workspaceId } = await devUserPrincipal(db, ORG);
  const machine = { kind: "machine" as const, machineId, workspaceId };
  const machines = localMachines(db, ORG);

  await machines.markOnline(machine);
  await machines.markOffline(machine, "disconnected");
  const text = await describeMachines(db, ORG);

  expect(text).toContain("machine.online");
  expect(text).toContain("machine.offline");
  expect(text).toContain("disconnected");
  expect(text).toContain("offline");
});

test("describeMachines shows only the 20 newest presence events", async () => {
  const db = migrated();
  const machineId = await enrollMachine(db);
  const { workspaceId } = await devUserPrincipal(db, ORG);
  const machine = { kind: "machine" as const, machineId, workspaceId };
  const machines = localMachines(db, ORG);

  // 260 online and offline flips make 520 events, more than one page of 500.
  for (let cycle = 0; cycle < 260; cycle += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the events must land in order
    await machines.markOnline(machine);
    await machines.markOffline(machine, "silent");
  }
  const eventLines = (await describeMachines(db, ORG))
    .split("\n")
    .filter(
      (line) =>
        line.includes("machine.online") || line.includes("machine.offline")
    );
  expect(eventLines).toHaveLength(20);
  expect(eventLines.at(-1)).toContain("machine.offline");
});

test("startMachineRun marks the run offered and reuses the agent", async () => {
  const db = migrated();
  const machineId = await enrollMachine(db);
  const principal = await devUserPrincipal(db, ORG);

  const first = await startMachineRun({
    db,
    machineId,
    orgId: ORG,
    text: "hi",
  });
  expect(first.agentId).toBeString();
  expect(first.runId).toBeString();
  const summary = await localRuns(db).getRun(principal, first.runId);
  expect(summary.status).toBe("offered");
  expect(summary.agentId).toBe(first.agentId);

  const second = await startMachineRun({
    db,
    machineId,
    orgId: ORG,
    text: "again",
  });
  expect(second.agentId).toBe(first.agentId);
  expect(second.runId).not.toBe(first.runId);

  const agents = await createAgentsService({
    db,
    events: localEvents(db),
  }).list(principal, { includeArchived: true });
  expect(agents.filter((agent) => agent.slug === "machine-echo")).toHaveLength(
    1
  );
});

test("startMachineRun refuses a machine outside the workspace", async () => {
  const db = migrated();
  await expect(
    startMachineRun({ db, machineId: "m_missing", orgId: ORG, text: "hi" })
  ).rejects.toThrow("is not in this workspace");
});

test("startMachineRun refuses an agent assigned to another machine", async () => {
  const db = migrated();
  const first = await enrollMachine(db, "first");
  const second = await enrollMachine(db, "second");
  await startMachineRun({ db, machineId: first, orgId: ORG, text: "hi" });
  await expect(
    startMachineRun({ db, machineId: second, orgId: ORG, text: "hi" })
  ).rejects.toThrow("is not assigned to machine");
});

test("startMachineRun refuses an archived agent", async () => {
  const db = migrated();
  const machineId = await enrollMachine(db);
  const principal = await devUserPrincipal(db, ORG);
  const { agentId } = await startMachineRun({
    db,
    machineId,
    orgId: ORG,
    text: "hi",
  });
  await createAgentsService({ db, events: localEvents(db) }).archive(
    principal,
    agentId
  );
  await expect(
    startMachineRun({ db, machineId, orgId: ORG, text: "hi" })
  ).rejects.toThrow("is archived");
});
