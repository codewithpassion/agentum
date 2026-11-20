// A workspace, two agents, a few people and runs, and the real library and
// memory services over an in-memory database. For the memory tests only.
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import {
  type MemoryLibraryBlobs,
  memoryLibraryBlobs,
} from "../library/memory.ts";
import { createLibraryService, type LibraryBlobs } from "../library.ts";
import type { Clock } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createMemoryService } from "./service.ts";

export const WORKSPACE = "w1";
export const AGENT = "agent_scout";
export const OTHER_AGENT = "agent_other";
export const OWNER = "user_owner";
export const USER_A = "user_a";
export const USER_B = "user_b";
const START = Date.parse("2026-11-20T10:00:00.000Z");

export const MEMORY = "agents/scout/memory";

/** A session or run the tests write notes from. */
export const SESSION = {
  mail: "s_mail",
  peer: "s_peer",
  privateA: "s_private_a",
  privateB: "s_private_b",
  ui: "s_ui",
} as const;
export const RUN = {
  bigCall: "r_big_call",
  browser: "r_browser",
  computerShell: "r_computer_shell",
  connector: "r_connector",
  connectorIdle: "r_connector_idle",
  connectorResource: "r_connector_resource",
  curl: "r_curl",
  desktop: "r_desktop",
  familyChild: "r_family_child",
  familyParent: "r_family_parent",
  machineSearch: "r_machine_search",
  machineWeb: "r_machine_web",
  mail: "r_mail",
  managedWeb: "r_managed_web",
  peer: "r_peer",
  privateA: "r_private_a",
  privateB: "r_private_b",
  script: "r_script",
  shell: "r_shell",
  skillScript: "r_skill_script",
  tools: "r_tools",
  ui: "r_ui",
  web: "r_web",
  webChild: "r_web_child",
} as const;

export const person = (
  userId: string,
  extra: Partial<Extract<Principal, { kind: "user" }>> = {}
): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId: WORKSPACE,
  ...extra,
});

export const run = (
  runId: string,
  agentId = AGENT,
  extra: { dryRun?: boolean } = {}
): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
  ...extra,
});

export const text = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes);

/** The error a promise rejects with, or null when it resolves. */
export const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

interface SessionSeed {
  actorId?: string;
  id: string;
  origin: string;
  private?: boolean;
}
interface RunSeed {
  actor?: { id: string; kind: string };
  id: string;
  onBehalfOfUserId: string | null;
  parentRunId?: string;
  sessionId: string;
}
interface EventSeed {
  id: string;
  /** Stored as JSON. Left out, the payload is null. */
  payload?: unknown;
  payloadRef?: string;
  runId: string;
  type: string;
}
/** A `tool.call` payload, as every runtime stores one. */
export const toolCall = (name: string) => ({
  input: {},
  name,
  toolUseId: "t1",
});
/** A `connector.call` payload, as the connector proxy stores one. */
export const connectorCall = (method: string, outcome: string) => ({
  connectorId: "c1",
  method,
  outcome,
  tool: method === "tools/call" ? "search" : null,
});

const IDLE_CONNECTOR_CALLS: readonly (readonly [string, string])[] = [
  ["initialize", "ok"],
  ["tools/list", "ok"],
  ["tools/call", "denied"],
  ["tools/call", "refused"],
  ["tools/call", "timeout"],
  ["tools/call", "unreachable"],
];

export const makeWorld = (
  options: {
    atomic?: ReturnType<typeof sqliteAtomic>;
    blobs?: (inner: MemoryLibraryBlobs) => LibraryBlobs;
  } = {}
) => {
  const db = migrated();
  const baseBlobs = memoryLibraryBlobs();
  let tick = START;
  const clock: Clock = {
    now: () => {
      tick += 1;
      return new Date(tick);
    },
    sleep: () => Promise.resolve(),
  };
  const atomic = options.atomic ?? sqliteAtomic(db);
  const eventsService = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  const library = createLibraryService({
    atomic,
    blobs: options.blobs ? options.blobs(baseBlobs) : baseBlobs,
    clock,
    db,
    events: eventsService,
  });
  const service = createMemoryService({
    atomic,
    clock,
    db,
    events: eventsService,
    library,
  });

  const createdAt = new Date(START).toISOString();
  db.insert(workspaces)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  for (const [id, slug] of [
    [AGENT, "scout"],
    [OTHER_AGENT, "other"],
  ] as const) {
    db.insert(agents)
      .values({
        createdAt,
        createdBy: OWNER,
        id,
        instructions: "",
        model: "m",
        name: slug,
        runtime: "fake",
        runtimeConfig: "{}",
        slug,
        status: "active",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const seedSession = (seed: SessionSeed) =>
    db
      .insert(sessions)
      .values({
        actorId: seed.actorId ?? USER_A,
        actorKind: "user",
        agentId: AGENT,
        createdAt,
        id: seed.id,
        origin: seed.origin,
        private: seed.private ?? false,
        workspaceId: WORKSPACE,
      })
      .run();
  const seedRun = (seed: RunSeed) => {
    const actor = seed.actor ?? { id: USER_A, kind: "user" };
    db.insert(runs)
      .values({
        actorId: actor.id,
        actorKind: actor.kind,
        agentId: AGENT,
        createdAt,
        id: seed.id,
        inputText: "hi",
        onBehalfOfUserId: seed.onBehalfOfUserId,
        parentRunId: seed.parentRunId ?? null,
        sessionId: seed.sessionId,
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
  };
  seedSession({ id: SESSION.ui, origin: "ui" });
  seedSession({
    id: SESSION.privateA,
    origin: "ui",
    private: true,
  });
  seedSession({
    actorId: USER_B,
    id: SESSION.privateB,
    origin: "ui",
    private: true,
  });
  seedSession({ id: SESSION.mail, origin: "mail" });
  seedSession({ id: SESSION.peer, origin: "a2a" });
  seedRun({ id: RUN.ui, onBehalfOfUserId: USER_A, sessionId: SESSION.ui });
  seedRun({ id: RUN.web, onBehalfOfUserId: USER_A, sessionId: SESSION.ui });
  // Runs that each used the web once, through one tool, and a run that used none.
  for (const id of [
    RUN.curl,
    RUN.script,
    RUN.machineWeb,
    RUN.managedWeb,
    RUN.machineSearch,
    RUN.shell,
    RUN.computerShell,
    RUN.browser,
    RUN.bigCall,
    RUN.desktop,
    RUN.skillScript,
    RUN.tools,
    RUN.familyParent,
    RUN.connector,
    RUN.connectorResource,
    RUN.connectorIdle,
  ]) {
    seedRun({ id, onBehalfOfUserId: USER_A, sessionId: SESSION.ui });
  }
  // A subagent of a run that used the web, and a parent whose subagent did.
  seedRun({
    id: RUN.webChild,
    onBehalfOfUserId: USER_A,
    parentRunId: RUN.web,
    sessionId: SESSION.ui,
  });
  seedRun({
    id: RUN.familyChild,
    onBehalfOfUserId: USER_A,
    parentRunId: RUN.familyParent,
    sessionId: SESSION.ui,
  });
  seedRun({
    id: RUN.privateA,
    onBehalfOfUserId: USER_A,
    sessionId: SESSION.privateA,
  });
  seedRun({
    actor: { id: USER_B, kind: "user" },
    id: RUN.privateB,
    onBehalfOfUserId: USER_B,
    sessionId: SESSION.privateB,
  });
  seedRun({ id: RUN.mail, onBehalfOfUserId: null, sessionId: SESSION.mail });
  seedRun({
    actor: { id: "conn_1", kind: "peer" },
    id: RUN.peer,
    onBehalfOfUserId: null,
    sessionId: SESSION.peer,
  });
  // A run the agent's own run set going, a child of the peer's run.
  seedRun({
    id: "r_peer_child",
    onBehalfOfUserId: null,
    parentRunId: RUN.peer,
    sessionId: SESSION.ui,
  });
  const seedEvent = (seed: EventSeed) =>
    db
      .insert(events)
      .values({
        actorId: AGENT,
        actorKind: "agent",
        agentId: AGENT,
        createdAt,
        id: seed.id,
        payload:
          seed.payload === undefined ? null : JSON.stringify(seed.payload),
        payloadRef: seed.payloadRef ?? null,
        runId: seed.runId,
        sessionId: SESSION.ui,
        type: seed.type,
        workspaceId: WORKSPACE,
      })
      .run();
  // A web_fetch call, which makes this run's notes web-sourced.
  seedEvent({
    id: "ev_web_1",
    payload: { via: "web_fetch" },
    runId: RUN.web,
    type: "network.request",
  });
  // One web use per run, and the ordinary tools that are not web use.
  seedEvent({
    id: "ev_curl_1",
    payload: { via: "curl" },
    runId: RUN.curl,
    type: "network.request",
  });
  seedEvent({
    id: "ev_script_1",
    payload: { via: "run_script" },
    runId: RUN.script,
    type: "network.request",
  });
  seedEvent({
    id: "ev_machine_web_1",
    payload: toolCall("WebFetch"),
    runId: RUN.machineWeb,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_managed_web_1",
    payload: toolCall("web_fetch"),
    runId: RUN.managedWeb,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_machine_search_1",
    payload: toolCall("WebSearch"),
    runId: RUN.machineSearch,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_shell_1",
    payload: toolCall("Bash"),
    runId: RUN.shell,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_computer_shell_1",
    payload: toolCall("mcp__harbourmaster__computer_exec"),
    runId: RUN.computerShell,
    type: "tool.call",
  });
  seedEvent({ id: "ev_browser_1", runId: RUN.browser, type: "browser.action" });
  seedEvent({
    id: "ev_desktop_1",
    payload: toolCall("harbourmaster_desktop_snapshot"),
    runId: RUN.desktop,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_skill_script_1",
    payload: toolCall("run_skill_script"),
    runId: RUN.skillScript,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_family_child_1",
    payload: toolCall("web_fetch"),
    runId: RUN.familyChild,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_big_call_1",
    payload: {},
    payloadRef: "payloads/w/ev.json",
    runId: RUN.bigCall,
    type: "tool.call",
  });
  // A connector call that got an answer, once through `tools/call` and once through `resources/read`.
  seedEvent({
    id: "ev_connector_1",
    payload: connectorCall("tools/call", "ok"),
    runId: RUN.connector,
    type: "connector.call",
  });
  seedEvent({
    id: "ev_connector_resource_1",
    payload: connectorCall("resources/read", "ok"),
    runId: RUN.connectorResource,
    type: "connector.call",
  });
  // What every run with a connector does, and calls that returned no text of the connector's.
  for (const [index, [method, outcome]] of IDLE_CONNECTOR_CALLS.entries()) {
    seedEvent({
      id: `ev_connector_idle_${index}`,
      payload: connectorCall(method, outcome),
      runId: RUN.connectorIdle,
      type: "connector.call",
    });
  }
  seedEvent({
    id: "ev_tools_read_1",
    payload: toolCall("Read"),
    runId: RUN.tools,
    type: "tool.call",
  });
  seedEvent({
    id: "ev_tools_write_1",
    payload: toolCall("Write"),
    runId: RUN.tools,
    type: "tool.call",
  });

  return {
    atomic,
    baseBlobs,
    clock,
    db,
    library,
    seedEvent,
    seedRun,
    service,
  };
};

export type World = ReturnType<typeof makeWorld>;
