import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import type { RoutineInfo, TriggerInfo } from "@repo/mcp/ports";
import { createAgentumMcpServer } from "@repo/mcp/server";
import { connectClient } from "@repo/mcp/testing";
import { isReadOnly } from "@repo/services/automation-access";
import type { EventFilters, EventRecord } from "@repo/services/events";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { type Composed, composeWith } from "../compose.ts";
import { createMcpPorts } from "./ports.ts";

const CRON = "0 9 * * 1-5";
const TRIGGER_PREFIX = "hm_trg_";
const PROPOSAL_TEXT = "waits for a person to approve it";
const AUTOMATION_WRITE_TOOLS = [
  "create_routine",
  "create_trigger",
  "set_routine_enabled",
  "set_trigger_enabled",
  "delete_routine",
  "delete_trigger",
];

let composed: Composed;
let clockNow: Date;
let workspaceId: string;
let userPrincipal: Principal;

beforeEach(async () => {
  const db = migrated(["org_a"]);
  const store = new Map<string, string>();
  clockNow = new Date("2026-10-19T08:00:00.000Z");
  composed = composeWith({
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
      clock: { now: () => clockNow, sleep: systemClock.sleep },
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  userPrincipal = {
    kind: "user",
    userId: "user_1",
    via: "session",
    workspaceId,
  };
});

/** An MCP session for `principal`, with the tools that principal may see. */
const connect = async (principal: Principal) => {
  const ports = createMcpPorts({ principal, services: composed.services });
  const server = createAgentumMcpServer(ports, {
    readOnly: isReadOnly(principal),
  });
  const { client, close } = await connectClient(server);
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ arguments: args, name }),
    close,
    listToolNames: async () =>
      (await client.listTools()).tools.map((tool) => tool.name),
  };
};

type Result = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["call"]>>;

const dataOf = (result: Result): Record<string, unknown> =>
  (result.structuredContent ?? {}) as Record<string, unknown>;

/** The code of a failed call, or null when the call succeeded. */
const errorCodeOf = (result: Result): unknown =>
  result.isError ? dataOf(result).code : null;

const routineOf = (result: Result) => dataOf(result).routine as RoutineInfo;
const triggerOf = (result: Result) => dataOf(result).trigger as TriggerInfo;

const textOf = (result: Result): string =>
  (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

const makeAgent = (name: string) =>
  composed.services.agents.create(userPrincipal, {
    model: "fake",
    name,
    runtime: "fake",
  });

/** A run of `agent`, and the principal a run's tools are called as. */
const startRunAs = async (agentId: string) => {
  const { runId } = await composed.services.runs.startRun(userPrincipal, {
    agentId,
    input: { text: "x" },
    session: { origin: "mcp" },
  });
  const run: Principal = { agentId, kind: "run", runId, workspaceId };
  return { run, runId };
};

const runSetup = async () => {
  const agent = await makeAgent("Echo");
  const other = await makeAgent("Other");
  const { run, runId } = await startRunAs(agent.id);
  // A routine a person made on the run's own agent, so a run's refusal to change it is about who made it.
  const personRoutine = await composed.services.routines.create(userPrincipal, {
    agentId: agent.id,
    cron: CRON,
    name: "Person",
    prompt: "Say hello",
  });
  return { agent, other, personRoutine, run, runId };
};

const routinesAsPerson = () => composed.services.routines.list(userPrincipal);
const triggersAsPerson = () => composed.services.triggers.list(userPrincipal);

const eventsOf = (types: NonNullable<EventFilters["types"]>) =>
  composed.services.events.query(userPrincipal, workspaceId, { types });

const viaOf = (event: EventRecord): unknown =>
  (event.payload.principal as { via?: unknown } | undefined)?.via;

test("a person creates, pauses, resumes and deletes a routine", async () => {
  const agent = await makeAgent("Echo");
  const session = await connect(userPrincipal);

  const created = await session.call("create_routine", {
    agentId: agent.id,
    cron: CRON,
    name: "Weekday check",
    prompt: "Check the queue",
  });
  expect(created.isError).toBeFalsy();
  const routine = routineOf(created);
  expect(routine.status).toBe("active");

  const listed = async () =>
    dataOf(await session.call("list_routines", {})).routines as RoutineInfo[];
  expect((await listed()).map((r) => r.id)).toContain(routine.id);

  const paused = routineOf(
    await session.call("set_routine_enabled", {
      enabled: false,
      routineId: routine.id,
    })
  );
  expect(paused.status).toBe("paused");

  const resumed = routineOf(
    await session.call("set_routine_enabled", {
      enabled: true,
      routineId: routine.id,
    })
  );
  expect(resumed.status).toBe("active");

  const deleted = await session.call("delete_routine", {
    routineId: routine.id,
  });
  expect(deleted.isError).toBeFalsy();
  expect((await listed()).map((r) => r.id)).not.toContain(routine.id);
  await session.close();
});

test("a person creates a trigger that shows its secret once, and pauses and deletes it", async () => {
  const agent = await makeAgent("Echo");
  const session = await connect(userPrincipal);

  const created = await session.call("create_trigger", {
    agentId: agent.id,
    name: "webhook",
  });
  expect(created.isError).toBeFalsy();
  const { secret } = dataOf(created) as { secret: string };
  expect(secret.startsWith(TRIGGER_PREFIX)).toBe(true);
  expect(textOf(created)).toContain(secret);
  const trigger = triggerOf(created);

  const listed = await session.call("list_triggers", {});
  const listedTriggers = dataOf(listed).triggers as TriggerInfo[];
  const row = listedTriggers.find((t) => t.id === trigger.id);
  expect(row?.tokenPrefix).toBe(secret.slice(0, TRIGGER_PREFIX.length + 4));
  expect(JSON.stringify(listed)).not.toContain(secret);
  expect(textOf(listed)).not.toContain(secret);

  const paused = await session.call("set_trigger_enabled", {
    enabled: false,
    triggerId: trigger.id,
  });
  expect(triggerOf(paused).status).toBe("paused");
  const resumed = await session.call("set_trigger_enabled", {
    enabled: true,
    triggerId: trigger.id,
  });
  expect(triggerOf(resumed).status).toBe("active");

  const deleted = await session.call("delete_trigger", {
    triggerId: trigger.id,
  });
  expect(deleted.isError).toBeFalsy();
  const afterDelete = dataOf(await session.call("list_triggers", {}))
    .triggers as TriggerInfo[];
  expect(afterDelete.map((t) => t.id)).not.toContain(trigger.id);
  await session.close();
});

test("a routine with an invalid cron is refused as a validation error", async () => {
  const agent = await makeAgent("Echo");
  const session = await connect(userPrincipal);
  const result = await session.call("create_routine", {
    agentId: agent.id,
    cron: "every tuesday",
    name: "Broken",
    prompt: "Never runs",
  });
  expect(errorCodeOf(result)).toBe("validation");
  await session.close();
});

test("a read-only API key or connected app lists routines and triggers and cannot change them", async () => {
  const agent = await makeAgent("Echo");
  await composed.services.routines.create(userPrincipal, {
    agentId: agent.id,
    cron: CRON,
    name: "Person",
    prompt: "Say hello",
  });
  const readers: Principal[] = [
    {
      apiKey: { access: "read", id: "k1" },
      kind: "user",
      userId: "user_1",
      via: "api_key",
      workspaceId,
    },
    {
      kind: "user",
      oauthClient: { access: "read", clientId: "c1" },
      userId: "user_1",
      via: "oauth",
      workspaceId,
    },
  ];
  for (const principal of readers) {
    // biome-ignore lint/performance/noAwaitInLoops: each reader is its own session
    const session = await connect(principal);

    const names = await session.listToolNames();
    expect(names).toContain("list_routines");
    expect(names).toContain("list_triggers");
    for (const name of AUTOMATION_WRITE_TOOLS) {
      expect(names).not.toContain(name);
    }

    const listed = await session.call("list_routines", {});
    expect(listed.isError).toBeFalsy();
    expect((dataOf(listed).routines as RoutineInfo[]).length).toBe(1);
    expect((await session.call("list_triggers", {})).isError).toBeFalsy();

    const ports = createMcpPorts({ principal, services: composed.services });
    await expect(
      ports.createRoutine({
        agentId: agent.id,
        cron: CRON,
        name: "Blocked",
        prompt: "Never",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    await session.close();
  }
});

test("a run's routine is a proposal that waits for approval and never fires", async () => {
  const { agent, personRoutine, run, runId } = await runSetup();
  const session = await connect(run);

  const created = await session.call("create_routine", {
    agentId: agent.id,
    cron: CRON,
    name: "Run proposal",
    prompt: "Summarise",
  });
  expect(created.isError).toBeFalsy();
  const routine = routineOf(created);
  expect(routine.status).toBe("awaiting_approval");
  expect(textOf(created)).toContain(PROPOSAL_TEXT);

  const stored = (await routinesAsPerson()).find((r) => r.id === routine.id);
  expect(stored?.disabledAt).not.toBeNull();
  expect(stored?.proposedByAgentId).toBe(agent.id);
  expect(stored?.proposedByRunId).toBe(runId);

  // Ten minutes past the slot the person's routine is due; the proposal is not.
  clockNow = new Date("2026-10-19T10:00:00.000Z");
  const fired = await composed.services.routines.fireDue(SYSTEM_PRINCIPAL);
  expect(fired.fired.length).toBe(1);
  const firedEvents = await eventsOf(["trigger.fired"]);
  const firedIds = firedEvents.map((event) => event.payload.triggerId);
  expect(firedIds).toContain(personRoutine.id);
  expect(firedIds).not.toContain(routine.id);
  await session.close();
});

test("a run cannot propose a routine for another agent", async () => {
  const { other, run } = await runSetup();
  const session = await connect(run);
  const result = await session.call("create_routine", {
    agentId: other.id,
    cron: CRON,
    name: "Elsewhere",
    prompt: "Not mine",
  });
  expect(errorCodeOf(result)).toBe("forbidden");
  await session.close();
});

test("a run cannot enable a routine, its own proposal or a person's", async () => {
  const { agent, personRoutine, run } = await runSetup();
  const session = await connect(run);
  const proposal = routineOf(
    await session.call("create_routine", {
      agentId: agent.id,
      cron: CRON,
      name: "Run proposal",
      prompt: "Summarise",
    })
  );

  expect(
    errorCodeOf(
      await session.call("set_routine_enabled", {
        enabled: true,
        routineId: proposal.id,
      })
    )
  ).toBe("forbidden");
  expect(
    errorCodeOf(
      await session.call("set_routine_enabled", {
        enabled: true,
        routineId: personRoutine.id,
      })
    )
  ).toBe("forbidden");

  const stored = (await routinesAsPerson()).find((r) => r.id === proposal.id);
  expect(stored?.disabledAt).not.toBeNull();
  const person = (await routinesAsPerson()).find(
    (r) => r.id === personRoutine.id
  );
  expect(person?.disabledAt).toBeNull();
  await session.close();
});

test("a run deletes only its own routine proposal", async () => {
  const { agent, personRoutine, run } = await runSetup();
  const session = await connect(run);
  const proposal = routineOf(
    await session.call("create_routine", {
      agentId: agent.id,
      cron: CRON,
      name: "Run proposal",
      prompt: "Summarise",
    })
  );

  expect(
    errorCodeOf(
      await session.call("delete_routine", { routineId: personRoutine.id })
    )
  ).toBe("forbidden");
  expect((await routinesAsPerson()).map((r) => r.id)).toContain(
    personRoutine.id
  );

  const deleted = await session.call("delete_routine", {
    routineId: proposal.id,
  });
  expect(deleted.isError).toBeFalsy();
  expect((await routinesAsPerson()).map((r) => r.id)).not.toContain(
    proposal.id
  );
  await session.close();
});

test("a run's trigger is a proposal with no secret, and it cannot be enabled", async () => {
  const { agent, run } = await runSetup();
  const session = await connect(run);

  const created = await session.call("create_trigger", {
    agentId: agent.id,
    name: "run webhook",
  });
  expect(created.isError).toBeFalsy();
  const trigger = triggerOf(created);
  expect(trigger.status).toBe("awaiting_approval");
  expect(textOf(created)).toContain(PROPOSAL_TEXT);

  const whole = JSON.stringify(created);
  expect(whole).not.toContain(TRIGGER_PREFIX);
  expect(whole).not.toContain('"secret"');

  const stored = (await triggersAsPerson()).find((t) => t.id === trigger.id);
  expect(stored?.tokenPrefix).toBe("");

  expect(
    errorCodeOf(
      await session.call("set_trigger_enabled", {
        enabled: true,
        triggerId: trigger.id,
      })
    )
  ).toBe("forbidden");
  await session.close();
});

test("a run lists only its own agent's routines and triggers", async () => {
  const { agent, other, personRoutine, run } = await runSetup();
  const otherRoutine = await composed.services.routines.create(userPrincipal, {
    agentId: other.id,
    cron: CRON,
    name: "Other person",
    prompt: "Say hi",
  });
  await composed.services.triggers.create(userPrincipal, {
    agentId: other.id,
    name: "other webhook",
  });
  const session = await connect(run);
  const proposal = routineOf(
    await session.call("create_routine", {
      agentId: agent.id,
      cron: CRON,
      name: "Run proposal",
      prompt: "Summarise",
    })
  );
  const ownTrigger = triggerOf(
    await session.call("create_trigger", { agentId: agent.id, name: "own" })
  );

  const routines = dataOf(await session.call("list_routines", {}))
    .routines as RoutineInfo[];
  expect(routines.map((r) => r.agentId)).toEqual([agent.id, agent.id]);
  expect(routines.map((r) => r.id).sort()).toEqual(
    [personRoutine.id, proposal.id].sort()
  );
  expect(routines.map((r) => r.id)).not.toContain(otherRoutine.id);

  const triggers = dataOf(await session.call("list_triggers", {}))
    .triggers as TriggerInfo[];
  expect(triggers.map((t) => t.id)).toEqual([ownTrigger.id]);
  expect(triggers.every((t) => t.agentId === agent.id)).toBe(true);
  await session.close();
});

test("a person approves or rejects proposals, and the events record each change", async () => {
  const agent = await makeAgent("Echo");
  const { run } = await startRunAs(agent.id);
  const person = await composed.services.routines.create(userPrincipal, {
    agentId: agent.id,
    cron: CRON,
    name: "Person",
    prompt: "Say hello",
  });
  const personTrigger = await composed.services.triggers.create(userPrincipal, {
    agentId: agent.id,
    name: "person webhook",
  });

  const runSession = await connect(run);
  const toApprove = routineOf(
    await runSession.call("create_routine", {
      agentId: agent.id,
      cron: CRON,
      name: "To approve",
      prompt: "Summarise",
    })
  );
  const triggerProposal = triggerOf(
    await runSession.call("create_trigger", {
      agentId: agent.id,
      name: "run webhook",
    })
  );
  const toReject = routineOf(
    await runSession.call("create_routine", {
      agentId: agent.id,
      cron: CRON,
      name: "To reject",
      prompt: "Summarise",
    })
  );
  const toDelete = routineOf(
    await runSession.call("create_routine", {
      agentId: agent.id,
      cron: CRON,
      name: "To delete",
      prompt: "Summarise",
    })
  );
  await runSession.call("delete_routine", { routineId: toDelete.id });
  await runSession.close();

  const approvedRoutine = await composed.services.routines.approve(
    userPrincipal,
    toApprove.id
  );
  expect(approvedRoutine.disabledAt).toBeNull();
  expect(approvedRoutine.nextRunAt).not.toBeNull();
  const session = await connect(userPrincipal);
  const listed = dataOf(await session.call("list_routines", {}))
    .routines as RoutineInfo[];
  const active = listed.find((r) => r.id === toApprove.id);
  expect(active?.status).toBe("active");
  expect(active?.nextRunAt).not.toBeNull();
  await session.close();

  const approvedTrigger = await composed.services.triggers.approve(
    userPrincipal,
    triggerProposal.id
  );
  expect(approvedTrigger.secret?.startsWith(TRIGGER_PREFIX)).toBe(true);

  await composed.services.routines.reject(userPrincipal, toReject.id);
  expect((await routinesAsPerson()).map((r) => r.id)).not.toContain(
    toReject.id
  );

  const events = await eventsOf([
    "trigger.created",
    "trigger.approved",
    "trigger.rejected",
    "trigger.deleted",
  ]);
  const eventsFor = (type: string, id: string) =>
    events.filter(
      (event) => event.type === type && event.payload.triggerId === id
    );

  for (const id of [
    toApprove.id,
    toReject.id,
    toDelete.id,
    triggerProposal.id,
  ]) {
    const created = eventsFor("trigger.created", id);
    expect(created.length).toBe(1);
    expect(created[0]?.actor).toEqual({ id: agent.id, kind: "agent" });
    expect(viaOf(created[0] as EventRecord)).toBe("run");
  }
  for (const id of [person.id, personTrigger.trigger.id]) {
    const created = eventsFor("trigger.created", id);
    expect(created.length).toBe(1);
    expect(created[0]?.actor).toEqual({ id: "user_1", kind: "user" });
    expect(viaOf(created[0] as EventRecord)).toBe("session");
  }
  expect(eventsFor("trigger.approved", toApprove.id).length).toBe(1);
  expect(eventsFor("trigger.approved", triggerProposal.id).length).toBe(1);
  expect(eventsFor("trigger.rejected", toReject.id).length).toBe(1);
  expect(eventsFor("trigger.deleted", toDelete.id).length).toBe(1);
  expect(eventsFor("trigger.approved", toApprove.id)[0]?.actor).toEqual({
    id: "user_1",
    kind: "user",
  });
});
