import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  agentConnectors as agentConnectorRows,
  connectors as connectorRows,
} from "@repo/db/schema/connectors";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { slackApps } from "@repo/db/schema/slack";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService, findAgent } from "../agents.ts";
import { createEventsService } from "../events.ts";
import { createMachineRuntime } from "../machines/runtime.ts";
import { noopRelay } from "../machines/types.ts";
import { serializeMemoryFile } from "../memory/codec.ts";
import type { MemoryFileReader } from "../memory/prompt.ts";
import { createRunsService } from "../runs.ts";
import { SLACK_GUIDANCE } from "../slack/guidance.ts";
import type { Principal } from "../workspaces.ts";
import { buildLaunchContext, type LaunchContext } from "./launch-context.ts";
import { loadRun } from "./queries.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let agentId: string;
let runId: string;

const addConnector = (id: string, createdAt: string) => {
  db.insert(connectorRows)
    .values({
      authKind: "none",
      createdAt: START,
      createdBy: "u1",
      id,
      name: id,
      status: "ok",
      url: `https://${id}.example/mcp`,
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(agentConnectorRows)
    .values({ agentId, connectorId: id, createdAt, workspaceId: WORKSPACE })
    .run();
};

const build = async (options: { readMemoryFile?: MemoryFileReader } = {}) => {
  const run = await loadRun(db, runId, WORKSPACE);
  const agent = await findAgent(db, { id: agentId, workspaceId: WORKSPACE });
  if (!(run && agent)) {
    throw new Error("fixture missing");
  }
  return await buildLaunchContext(db, run, agent, options);
};

const memoryNote = (n: number, text: string, userScope: string | null) => ({
  date: "2026-10-16",
  id: `01HZ7KQ3M8V2X4R6T9B1C5${String(n).padStart(4, "0")}`,
  kind: "work" as const,
  source: null,
  text,
  userScope,
  writtenBy: "agent" as const,
});

const memoryFiles =
  (files: Record<string, string>): MemoryFileReader =>
  (path) =>
    Promise.resolve(files[path] ?? null);

const notesOf = (context: LaunchContext) => {
  if (!context.memory) {
    throw new Error("no memory in the launch context");
  }
  return context.memory.notes;
};

beforeEach(async () => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: "m1",
      enrolledBy: "u1",
      id: "m1",
      lastSeenAt: null,
      name: "m1",
      singleUser: false,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(user, {
      machineId: "m1",
      model: "m",
      name: "Box",
      runtime: "machine",
    })
  ).id;
  const runs = createRunsService({
    adapters: [createMachineRuntime({ relay: noopRelay })],
    atomic: sqliteAtomic(db),
    blobs,
    clock: { now: () => new Date(START), sleep: () => Promise.resolve() },
    db,
    devFakeRuntime: false,
    gateways: [],
    runTokenKey: KEY,
  });
  const started = await runs.startRun(user, {
    agentId,
    input: { text: "hi" },
    session: { origin: "ui" },
  });
  ({ runId } = started);
});

test("a launch context holds the model, ordered connectors, Slack text and speaker flag", async () => {
  addConnector("c-late", "2026-10-16T10:00:02.000Z");
  addConnector("c-early", "2026-10-16T10:00:01.000Z");
  db.insert(slackApps)
    .values({
      agentId,
      appId: "A0SLACK",
      botToken: null,
      botUserId: "U0BOT",
      createdAt: START,
      id: "app1",
      signingSecret: "ciphertext",
      status: "installed",
      teamId: "T0TEAM",
      workspaceId: WORKSPACE,
    })
    .run();

  const context = await build();

  expect(context.model).toBe("m");
  expect(context.connectors.map((connector) => connector.id)).toEqual([
    "c-early",
    "c-late",
  ]);
  expect(context.slack).toContain(SLACK_GUIDANCE.split("\n")[0] ?? "");
  expect(context.handoffNames).toEqual([]);
  expect(context.multiPerson).toBe(false);
  expect(context.scope).toBeNull();
});

test("a run's access scope narrows the connectors in the context", async () => {
  addConnector("c1", "2026-10-16T10:00:01.000Z");
  addConnector("c2", "2026-10-16T10:00:02.000Z");
  db.update(runRows)
    .set({ accessScope: JSON.stringify({ connectors: ["c2"] }) })
    .where(eq(runRows.id, runId))
    .run();

  const context = await build();

  expect(context.connectors.map((connector) => connector.id)).toEqual(["c2"]);
  expect(context.scope).toEqual({ connectors: ["c2"] });
});

test("with a memory reader the context holds the agent's notes and the run person's private notes only", async () => {
  db.update(runRows)
    .set({ onBehalfOfUserId: "user_a1" })
    .where(eq(runRows.id, runId))
    .run();
  const read = memoryFiles({
    "private/user_a1.md": serializeMemoryFile("private/user_a1.md", [
      memoryNote(3, "Ana's private brief", "user_a1"),
    ]),
    "private/user_b2.md": serializeMemoryFile("private/user_b2.md", [
      memoryNote(4, "Ben's private brief", "user_b2"),
    ]),
    "work.md": serializeMemoryFile("work.md", [
      memoryNote(1, "Trade show list waits on Tally", null),
    ]),
  });

  const context = await build({ readMemoryFile: read });

  expect(
    notesOf(context)
      .map((item) => item.id)
      .sort()
  ).toEqual(["01HZ7KQ3M8V2X4R6T9B1C50001", "01HZ7KQ3M8V2X4R6T9B1C50003"]);
});

test("a run with no person behind it sees no private notes", async () => {
  db.update(runRows)
    .set({ onBehalfOfUserId: null })
    .where(eq(runRows.id, runId))
    .run();
  const read = memoryFiles({
    "private/user_a1.md": serializeMemoryFile("private/user_a1.md", [
      memoryNote(3, "Ana's private brief", "user_a1"),
    ]),
    "work.md": serializeMemoryFile("work.md", [
      memoryNote(1, "Trade show list waits on Tally", null),
    ]),
  });

  const context = await build({ readMemoryFile: read });

  expect(notesOf(context).map((item) => item.id)).toEqual([
    "01HZ7KQ3M8V2X4R6T9B1C50001",
  ]);
});

test("without a memory reader the context has no memory", async () => {
  expect((await build()).memory).toBeNull();
});
