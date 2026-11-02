import { describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agentLibraryAccess } from "@repo/db/schema/library";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { createAgentProfileService } from "../agent-profile.ts";
import { type AgentRecord, createAgentsService } from "../agents.ts";
import { ForbiddenError } from "../authz.ts";
import { CLOUD_DEFAULT_MODEL } from "../cloud/models.ts";
import type { ConnectorSummary } from "../connectors.ts";
import { createConnectorsService } from "../connectors.ts";
import { createDeskService } from "../desk.ts";
import { ServiceError } from "../errors.ts";
import { createEventsService } from "../events.ts";
import { createInboxService } from "../inbox.ts";
import { createLibraryAccessService } from "../library/access.ts";
import { memoryLibraryBlobs } from "../library/memory.ts";
import { createLibraryService } from "../library.ts";
import { noopRelay } from "../machines/types.ts";
import { createMachinesService } from "../machines.ts";
import { createRequestsService } from "../requests.ts";
import { createRoutinesService } from "../routines.ts";
import type { RuntimeAdapter } from "../runs/types.ts";
import { createRunsService } from "../runs.ts";
import { createSecretsService } from "../secrets.ts";
import { createSessionsService } from "../sessions.ts";
import { memorySkillBlobs } from "../skills-store/memory.ts";
import type { SkillRecord } from "../skills-store/records.ts";
import { createSkillsStoreService } from "../skills-store.ts";
import { createSlackAppsService } from "../slack-apps.ts";
import { createTasksService } from "../tasks/service.ts";
import { createTriggersService } from "../triggers.ts";
import type { Principal } from "../workspaces.ts";
import type { AgentDraft } from "./draft.ts";
import { type AgentBuilderDeps, createAgentBuilderService } from "./service.ts";

type ActivateInput = Parameters<AgentBuilderDeps["agents"]["activate"]>[2];
type CreateDraftInput = Parameters<
  AgentBuilderDeps["agents"]["createDraft"]
>[1];
type RoutineInput = Parameters<AgentBuilderDeps["routines"]["create"]>[1];
type RunInput = Parameters<AgentBuilderDeps["runs"]["startRun"]>[1];
type RunOptions = Parameters<AgentBuilderDeps["runs"]["startRun"]>[2];

const user: Principal = {
  kind: "user",
  userId: "user_1",
  via: "session",
  workspaceId: "ws_1",
};

const draft: AgentDraft = {
  does: "Sort the inbox",
  handsTo: [],
  library: ["notes/research"],
  name: "Inbox helper",
  rules: ["Never send mail"],
  runsOn: { runtime: "cloud" },
  sampleInput: [],
  skills: ["skill_people"],
  startsOn: [
    {
      cron: "0 9 * * 1",
      kind: "routine",
      label: "Monday digest",
      prompt: "Write the digest",
    },
    { kind: "mail" },
    { kind: "slack_mention" },
  ],
  tools: ["conn_mail"],
  voice: "careful",
};

const agentRecord = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  backupUserId: null,
  computerMachineId: null,
  createdAt: "2026-10-27T09:00:00.000Z",
  createdBy: "user_1",
  emailLocal: null,
  handsTo: [],
  id: "agent_1",
  instructions: "Sort the inbox",
  machineId: null,
  model: CLOUD_DEFAULT_MODEL,
  name: "Inbox helper",
  ownerUserId: null,
  runtime: "cloud",
  runtimeConfig: {},
  slug: "inbox-helper",
  soul: "",
  status: "draft",
  workspaceId: "ws_1",
  ...overrides,
});

interface WorldOptions {
  emailLocal?: string | null;
  /** Keyed by the call label, for example "assign:conn_mail". The call is recorded, then it throws. */
  failures?: Record<string, Error>;
  status?: AgentRecord["status"];
}

/** Recording fakes for every dependency of the builder. Writes log to `calls` in order. */
const makeWorld = (options: WorldOptions = {}) => {
  const calls: string[] = [];
  const failures = new Map(Object.entries(options.failures ?? {}));
  const activateInputs: ActivateInput[] = [];
  const createDraftInputs: CreateDraftInput[] = [];
  const routineInputs: RoutineInput[] = [];
  const runInputs: { input: RunInput; options: RunOptions }[] = [];
  const suggestCalls: string[] = [];
  let row = agentRecord({
    emailLocal: options.emailLocal ?? null,
    status: options.status ?? "draft",
  });

  const record = (label: string): Promise<void> => {
    calls.push(label);
    const failure = failures.get(label);
    return failure ? Promise.reject(failure) : Promise.resolve();
  };

  const agents: AgentBuilderDeps["agents"] = {
    activate: async (_principal, _agentId, input) => {
      await record("activate");
      activateInputs.push(input);
      row = {
        ...row,
        machineId: input.machineId ?? null,
        model: input.model,
        runtime: input.runtime,
        runtimeConfig: input.runtimeConfig ?? {},
        status: "active",
      };
      return row;
    },
    createDraft: async (_principal, input) => {
      await record("createDraft");
      createDraftInputs.push(input);
      return row;
    },
    discardDraft: async () => {
      await record("discard");
      return agentRecord({ status: "archived" });
    },
    get: async () => row,
    list: async () => [],
    reserveAddress: async (_principal, _agentId, local) => {
      await record(`reserve:${local}`);
      row = { ...row, emailLocal: local };
      return row;
    },
    suggestAddress: (slug) => {
      suggestCalls.push(slug);
      return Promise.resolve("inbox-helper-2");
    },
    update: async () => {
      await record("update");
      return row;
    },
  };

  const connectors: AgentBuilderDeps["connectors"] = {
    assign: async (_principal, input) => {
      await record(`assign:${input.connectorId}`);
      return {} as never;
    },
    list: async () => [
      {
        id: "conn_mail",
        name: "Mail Connector",
        tools: [{ description: null, name: "read", readOnly: true }],
        url: "https://mail.example/mcp",
      } as ConnectorSummary,
    ],
  };

  const libraryAccess: AgentBuilderDeps["libraryAccess"] = {
    setGrant: async (_principal, _agentId, path, mode) => {
      await record(`grant:${path}:${mode}`);
    },
  };

  const skillsStore: AgentBuilderDeps["skillsStore"] = {
    assign: async (_principal, input) => {
      await record(`assignSkill:${input.skillId}`);
      return {} as never;
    },
    list: async () => [
      {
        id: "skill_people",
        name: "Summarize",
        ownerAgentId: null,
      } as SkillRecord,
    ],
  };

  const routines: AgentBuilderDeps["routines"] = {
    create: async (_principal, input) => {
      await record(`routine:${input.name}`);
      routineInputs.push(input);
      return {} as never;
    },
  };

  const runs: AgentBuilderDeps["runs"] = {
    startRun: async (_principal, input, runOptions) => {
      await record("startRun");
      runInputs.push({ input, options: runOptions ?? {} });
      return { runId: "run_1", sessionId: "session_1", status: "queued" };
    },
  };

  const deps: AgentBuilderDeps = {
    agents,
    connectors,
    fetch: () => Promise.reject(new Error("unused")),
    libraryAccess,
    machines: { list: async () => [] },
    managedKeys: {
      resolve: async () => ({ apiKey: "sk-ant-test", environmentId: null }),
      status: async () => ({ configured: true, hint: "sk-a", updatedAt: null }),
    },
    modelKeys: {
      status: async () => ({ configured: false, hint: null, updatedAt: null }),
    },
    routines,
    runs,
    skillsStore,
  };

  return {
    activateInputs,
    calls,
    createDraftInputs,
    deps,
    routineInputs,
    runInputs,
    service: createAgentBuilderService(deps),
    suggestCalls,
  };
};

describe("saveDraft", () => {
  test("without an id creates a draft row with the rules in the instructions and the voice as soul", async () => {
    const world = makeWorld();

    await world.service.saveDraft(user, { draft });

    expect(world.calls).toEqual(["createDraft"]);
    const [input] = world.createDraftInputs;
    expect(input).toMatchObject({
      handsTo: [],
      instructions: "Sort the inbox\n\nRules:\n- Never send mail",
      name: "Inbox helper",
    });
    expect(input?.runtimeConfig).toBeUndefined();
    expect(input?.soul).toStartWith("Be careful.");

    const brief = makeWorld();
    await brief.service.saveDraft(user, {
      draft: { ...draft, voice: "brief" },
    });
    expect(input?.soul).not.toBe(brief.createDraftInputs[0]?.soul);
  });

  test("with the id of a draft updates that row instead of creating one", async () => {
    const world = makeWorld();

    await world.service.saveDraft(user, { draft, draftAgentId: "agent_1" });

    expect(world.calls).toEqual(["update"]);
    expect(world.createDraftInputs).toEqual([]);
  });

  test("with the id of an active agent throws invalid and writes nothing", async () => {
    const world = makeWorld({ status: "active" });

    const error = await world.service
      .saveDraft(user, { draft, draftAgentId: "agent_1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect(world.calls).toEqual([]);
  });
});

describe("dryRun", () => {
  test("starts one private dry run with the sample as key: value lines", async () => {
    const world = makeWorld();

    const result = await world.service.dryRun(user, {
      draftAgentId: "agent_1",
      sample: [
        { key: "topic", value: "cats" },
        { key: "tone", value: "dry" },
      ],
    });

    expect(world.calls).toEqual(["startRun"]);
    expect(world.runInputs).toEqual([
      {
        input: {
          agentId: "agent_1",
          input: { text: "topic: cats\ntone: dry" },
          session: { origin: "dry_run", private: true },
        },
        options: { dryRun: true },
      },
    ]);
    expect(result).toEqual({ runId: "run_1", sessionId: "session_1" });
  });

  test("an empty sample still sends text", async () => {
    const world = makeWorld();

    await world.service.dryRun(user, { draftAgentId: "agent_1", sample: [] });

    const [run] = world.runInputs;
    expect(typeof run?.input.input.text).toBe("string");
    expect(run?.input.input.text.length).toBeGreaterThan(0);
  });

  test("a non-draft agent is refused with invalid and no run starts", async () => {
    const world = makeWorld({ status: "active" });

    const error = await world.service
      .dryRun(user, { draftAgentId: "agent_1", sample: [] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect(world.calls).toEqual([]);
  });
});

describe("create", () => {
  test("runs the steps in order and reserves a suggested address when none is given", async () => {
    const world = makeWorld();

    await world.service.create(user, { draft, draftAgentId: "agent_1" });

    expect(world.calls).toEqual([
      "update",
      "activate",
      "assign:conn_mail",
      "assignSkill:skill_people",
      "grant:notes/research:write",
      "routine:Monday digest",
      "reserve:inbox-helper-2",
    ]);
    expect(world.suggestCalls).toEqual(["inbox-helper"]);
    expect(world.activateInputs).toEqual([
      {
        machineId: null,
        model: CLOUD_DEFAULT_MODEL,
        runtime: "cloud",
      },
    ]);
    expect(world.routineInputs).toEqual([
      {
        agentId: "agent_1",
        cron: "0 9 * * 1",
        name: "Monday digest",
        prompt: "Write the digest",
      },
    ]);
  });

  test("an address in the input is reserved as given, without a suggestion", async () => {
    const world = makeWorld();

    await world.service.create(user, {
      address: "helper-x",
      draft,
      draftAgentId: "agent_1",
    });

    expect(world.calls).toContain("reserve:helper-x");
    expect(world.calls.some((call) => call.startsWith("reserve:inbox"))).toBe(
      false
    );
    expect(world.suggestCalls).toEqual([]);
  });

  test("an agent that already has an address makes no reserve call", async () => {
    const world = makeWorld({ emailLocal: "helper-taken" });

    await world.service.create(user, { draft, draftAgentId: "agent_1" });

    expect(world.calls).toEqual([
      "update",
      "activate",
      "assign:conn_mail",
      "assignSkill:skill_people",
      "grant:notes/research:write",
      "routine:Monday digest",
    ]);
    expect(world.suggestCalls).toEqual([]);
  });

  test("an unknown connector is an open gap: invalid, and nothing is written", async () => {
    const world = makeWorld();

    const error = await world.service
      .create(user, {
        draft: { ...draft, tools: ["conn_ghost"] },
        draftAgentId: "agent_1",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect((error as Error).message).toContain("conn_ghost");
    expect(world.calls).toEqual([]);
  });

  test("a missing runtime is an open gap: invalid, and nothing is written", async () => {
    const world = makeWorld();

    const error = await world.service
      .create(user, {
        draft: { ...draft, runsOn: null },
        draftAgentId: "agent_1",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "invalid" });
    expect((error as Error).message).toContain("Where it runs");
    expect(world.calls).toEqual([]);
  });

  test("a failed step stops the rest, names what was done and what was not", async () => {
    const world = makeWorld({
      failures: { "assign:conn_mail": new ServiceError("conflict", "boom") },
    });

    const error = await world.service
      .create(user, { draft, draftAgentId: "agent_1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "conflict" });
    const { message } = error as Error;
    expect(message).toContain("boom");
    expect(message).toContain('"Give it the Mail Connector connector" failed');
    expect(message).toContain("Done: nothing else");
    const notDone = message.slice(message.indexOf("Not done:"));
    expect(notDone).toContain("Reserve its address");
    expect(world.calls).toEqual(["update", "activate", "assign:conn_mail"]);
  });

  test("a failure after the first connector reports the connector as done", async () => {
    const world = makeWorld({
      failures: {
        "assignSkill:skill_people": new ServiceError("conflict", "skill gone"),
      },
    });

    const error = await world.service
      .create(user, { draft, draftAgentId: "agent_1" })
      .catch((caught: unknown) => caught);

    const { message } = error as Error;
    expect(message).toContain("Done: Give it the Mail Connector connector");
    expect(message).toContain("Not done: Give it the Summarize skill");
    expect(world.calls).toEqual([
      "update",
      "activate",
      "assign:conn_mail",
      "assignSkill:skill_people",
    ]);
  });
});

describe("create, library folders", () => {
  test("a failed grant is named in the error, with what landed and what did not", async () => {
    const world = makeWorld({
      failures: {
        "grant:notes/research:write": new ServiceError("not_found", "no way"),
      },
    });

    const error = await world.service
      .create(user, { draft, draftAgentId: "agent_1" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "not_found" });
    const { message } = error as Error;
    expect(message).toContain(
      '"Give it write access to notes/research" failed: no way'
    );
    expect(message).toContain("Done: Give it the Mail Connector connector");
    expect(message).toContain(
      "Not done: Give it write access to notes/research"
    );
    expect(message).toContain("Reserve its address");
  });
});

describe("discard", () => {
  test("discards the draft and returns its record", async () => {
    const world = makeWorld();

    const result = await world.service.discard(user, "agent_1");

    expect(world.calls).toEqual(["discard"]);
    expect(result).toMatchObject({ status: "archived" });
  });

  test("discarding an already archived draft again still returns it", async () => {
    const world = makeWorld();

    await world.service.discard(user, "agent_1");
    const again = await world.service.discard(user, "agent_1");

    expect(world.calls).toEqual(["discard", "discard"]);
    expect(again).toMatchObject({ status: "archived" });
  });
});

describe("the system principal", () => {
  const system: Principal = { kind: "system" };

  test("is refused by every lifecycle method and nothing is called", async () => {
    const world = makeWorld();

    await expect(
      world.service.saveDraft(system, { draft })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      world.service.dryRun(system, { draftAgentId: "agent_1", sample: [] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      world.service.create(system, { draft, draftAgentId: "agent_1" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      world.service.discard(system, "agent_1")
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(world.calls).toEqual([]);
    expect(world.runInputs).toEqual([]);
  });
});

/** A stub for a dependency the dry run never reaches. */
const unused = (): Promise<never> => Promise.reject(new Error("unused"));

describe("dry run on the real services", () => {
  const NOW = Date.parse("2026-10-27T09:00:00Z");
  const DAY_START = "2026-10-27T00:00:00.000Z";
  const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };

  test("the run is a hidden dry run, dispatched to cloud, and its session stays readable", async () => {
    const db = migrated();
    await db.insert(workspaces).values({
      clerkOrgId: "org_ws_1",
      createdAt: new Date(NOW).toISOString(),
      id: "ws_1",
      name: "ws_1",
      timezone: "UTC",
    });
    const blobs = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    };
    const atomic = sqliteAtomic(db);
    const events = createEventsService({ blobs, db });
    const dispatched: string[] = [];
    const adapter: RuntimeAdapter = {
      cancel: () => Promise.resolve(),
      dispatch: (_db, run) => {
        dispatched.push(run.id);
        return Promise.resolve();
      },
      kind: "cloud",
      resume: () => Promise.resolve(),
    };
    const runs = createRunsService({
      adapters: [adapter],
      atomic,
      blobs,
      clock,
      db,
      devFakeRuntime: false,
      gateways: [],
    });
    const requests = createRequestsService({
      atomic,
      clock,
      db,
      events,
      runs,
      secrets: { maskerFor: () => Promise.resolve(createMasker({})) },
    });
    const library = createLibraryService({
      atomic,
      blobs: memoryLibraryBlobs(),
      clock,
      db,
      events,
    });
    const skillsStore = createSkillsStoreService({
      atomic,
      blobs: memorySkillBlobs(),
      clock,
      db,
      events,
      library,
    });
    const triggers = createTriggersService({
      clock,
      db,
      events,
      runs,
    });
    const routines = createRoutinesService({
      clock,
      db,
      events,
      runs,
    });
    const inbox = createInboxService({
      atomic,
      clock,
      db,
      events,
      runs: { startRun: (principal, input) => runs.startRun(principal, input) },
    });
    const desk = createDeskService({
      clock,
      db,
      inbox,
      requests,
      routines,
      skillsStore,
      triggers,
    });
    const tasks = createTasksService({
      clock,
      db,
      events,
      eventTypes: ["message.user", "message.assistant"],
      requests,
    });
    const sessions = createSessionsService({ db, events });
    const agents = createAgentsService({ db, events });
    const builder = createAgentBuilderService({
      agents,
      connectors: { assign: unused, list: unused },
      fetch: unused,
      libraryAccess: { setGrant: unused },
      machines: { list: unused },
      managedKeys: { resolve: unused, status: unused },
      modelKeys: { status: unused },
      routines,
      runs,
      skillsStore,
    });

    const owner: Principal = {
      kind: "user",
      userId: "user_1",
      via: "session",
      workspaceId: "ws_1",
    };
    const active = await agents.create(owner, {
      model: "m",
      name: "Alpha",
      runtime: "cloud",
    });
    // A real run on an active agent, so the control shows up in the lists.
    const normal = await runs.startRun(owner, {
      agentId: active.id,
      input: { text: "Real task" },
      session: { origin: "mcp" },
    });
    const draftAgent = await agents.createDraft(owner, { name: "Draft" });

    const { runId, sessionId } = await builder.dryRun(owner, {
      draftAgentId: draftAgent.id,
      sample: [{ key: "topic", value: "cats" }],
    });

    const [row] = await db.select().from(runRows).where(eq(runRows.id, runId));
    expect(row).toMatchObject({ dryRun: true, sessionId });
    const [session] = await db
      .select()
      .from(sessionRows)
      .where(eq(sessionRows.id, sessionId));
    expect(session).toMatchObject({ origin: "dry_run", private: true });
    expect(dispatched).toEqual([normal.runId, runId]);

    const deskView = JSON.stringify(
      await desk.get(owner, { dayStart: DAY_START })
    );
    expect(deskView).toContain(normal.runId);
    expect(deskView).not.toContain(runId);

    const listed = await tasks.list(owner, { limit: 50 });
    expect(listed.map((task) => task.id)).toContain(normal.runId);
    expect(listed.map((task) => task.id)).not.toContain(runId);

    await expect(sessions.get(owner, sessionId)).resolves.toMatchObject({
      id: sessionId,
      origin: "dry_run",
      private: true,
    });
  });
});

describe("create on the real services", () => {
  const NOW = "2026-10-27T09:00:00.000Z";
  const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };

  test("each library folder becomes a write grant, listed on the profile, and none lands in runtimeConfig", async () => {
    const db = migrated();
    await db.insert(workspaces).values({
      clerkOrgId: "org_ws_1",
      createdAt: NOW,
      id: "ws_1",
      name: "ws_1",
      timezone: "UTC",
    });
    const blobs = {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    };
    const atomic = sqliteAtomic(db);
    const events = createEventsService({ blobs, db });
    const adapter: RuntimeAdapter = {
      cancel: () => Promise.resolve(),
      dispatch: () => Promise.resolve(),
      kind: "cloud",
      resume: () => Promise.resolve(),
    };
    const runs = createRunsService({
      adapters: [adapter],
      atomic,
      blobs,
      clock,
      db,
      devFakeRuntime: false,
      gateways: [],
    });
    const requests = createRequestsService({
      atomic,
      clock,
      db,
      events,
      runs,
      secrets: { maskerFor: () => Promise.resolve(createMasker({})) },
    });
    const library = createLibraryService({
      atomic,
      blobs: memoryLibraryBlobs(),
      clock,
      db,
      events,
    });
    const skillsStore = createSkillsStoreService({
      atomic,
      blobs: memorySkillBlobs(),
      clock,
      db,
      events,
      library,
    });
    const triggers = createTriggersService({
      clock,
      db,
      events,
      runs,
    });
    const routines = createRoutinesService({
      clock,
      db,
      events,
      runs,
    });
    const agents = createAgentsService({ db, events });
    const connectors = createConnectorsService({
      atomic,
      clock,
      db,
      events,
      fetch: unused,
    });
    const machines = createMachinesService({
      atomic,
      clock,
      db,
      events,
      relay: noopRelay,
    });
    const libraryAccess = createLibraryAccessService({
      atomic,
      clock,
      db,
      events,
    });
    const builder = createAgentBuilderService({
      agents,
      connectors,
      fetch: unused,
      libraryAccess,
      machines,
      managedKeys: {
        resolve: unused,
        status: () =>
          Promise.resolve({ configured: true, hint: "sk-a", updatedAt: null }),
      },
      modelKeys: {
        status: () =>
          Promise.resolve({ configured: false, hint: null, updatedAt: null }),
      },
      routines,
      runs,
      skillsStore,
    });
    const profiles = createAgentProfileService({
      agents,
      connectors,
      db,
      machines,
      requests,
      routines,
      secrets: createSecretsService({
        atomic,
        clock,
        db,
        events,
        secretsKey: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32))
        ).toString("base64"),
      }),
      skillsStore,
      slackApps: createSlackAppsService({
        atomic,
        clock,
        db,
        events,
        fetch: unused,
        publicBaseUrl: "https://hm.example.com",
        secretsKey: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32))
        ).toString("base64"),
      }),
      tasks: createTasksService({
        clock,
        db,
        events,
        eventTypes: [],
        requests,
      }),
      triggers,
    });

    const owner: Principal = {
      kind: "user",
      userId: "user_1",
      via: "session",
      workspaceId: "ws_1",
    };
    const draftAgent = await agents.createDraft(owner, { name: "Folders" });
    const created = await builder.create(owner, {
      draft: {
        ...draft,
        library: ["notes/research", "shared/brand"],
        skills: [],
        startsOn: [],
        tools: [],
      },
      draftAgentId: draftAgent.id,
    });

    const grants = await db
      .select({
        mode: agentLibraryAccess.mode,
        path: agentLibraryAccess.path,
      })
      .from(agentLibraryAccess)
      .where(eq(agentLibraryAccess.agentId, created.id));
    expect(grants.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { mode: "write", path: "notes/research" },
      { mode: "write", path: "shared/brand" },
    ]);
    expect(created.runtimeConfig).toEqual({});
    const { library: folders } = await profiles.profile(owner, {
      agentId: created.id,
    });
    expect(folders.folders).toEqual(
      expect.arrayContaining([
        { access: "write", home: false, path: "notes/research" },
        { access: "write", home: false, path: "shared/brand" },
      ])
    );
  });
});
