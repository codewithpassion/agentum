/**
 * The services an inbound A2A task test runs against, wired the way
 * `composeWith` wires them: the real runs, requests, events, connections and
 * tasks services over `migrated()`, with a cloud adapter that starts nothing,
 * so a test moves each run by hand. Test code only.
 */

import type { SendMessageRequest } from "@repo/a2a/requests";
import { sqliteAtomic } from "@repo/db/atomic";
import { a2aAgentCards, a2aConnections } from "@repo/db/schema/a2a";
import { agents as agentRows } from "@repo/db/schema/agents";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createEventsService } from "../events.ts";
import { createRequestsService } from "../requests.ts";
import type { RuntimeAdapter } from "../runs/types.ts";
import { createRunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createConnectionsService, type PeerPrincipal } from "./connections.ts";
import { createA2aTasksService } from "./tasks.ts";

export const START = "2026-11-01T10:00:00.000Z";
export const SECRETS_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7))
);
export const WORKSPACE = "w-alice";
export const OTHER_WORKSPACE = "w-bob";
export const AGENT = "a-x";
export const CONNECTION = "con_one";
export const OTHER_CONNECTION = "con_two";

/** A person on a browser session in the workspace. */
export const member = (
  userId = "u-member",
  workspaceId = WORKSPACE
): Principal => ({
  isAdmin: false,
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

export const peerOf = (
  connectionId = CONNECTION,
  hops?: number
): PeerPrincipal => ({
  agentId: AGENT,
  connectionId,
  ...(hops === undefined ? {} : { hops }),
  kind: "peer",
  workspaceId: WORKSPACE,
});

/** A plain text message from a peer, as Hermes sends it, with `mediaType`. */
export const textMessage = (
  messageId: string,
  text: string,
  extra: Partial<SendMessageRequest["message"]> = {}
): SendMessageRequest => ({
  message: {
    messageId,
    parts: [{ mediaType: "text/plain", text }],
    role: "ROLE_USER",
    ...extra,
  },
});

export const createFixture = async (options: { fake?: boolean } = {}) => {
  const db = migrated();
  let nowMs = Date.parse(START);
  const clock = {
    now: () => new Date(nowMs),
    sleep: () => Promise.resolve(),
  };
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  await db.insert(workspaceRows).values(
    (
      [
        [WORKSPACE, "Alice Org"],
        [OTHER_WORKSPACE, "Bob Org"],
      ] as const
    ).map(([id, name]) => ({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name,
      timezone: "UTC",
    }))
  );
  /** An active agent, published as the connections service would publish it. */
  const seedAgent = async (
    id: string,
    runtime: "cloud" | "machine" | "managed" | "fake" = "cloud"
  ) => {
    await db.insert(agentRows).values({
      createdAt: START,
      createdBy: "u-owner",
      id,
      instructions: "Be helpful.",
      model: "m",
      name: `Agent ${id}`,
      runtime,
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId: WORKSPACE,
    });
    await db.insert(a2aAgentCards).values({
      agentId: id,
      description: "A test agent",
      id: `card_${id}`,
      publicId: `pub_${id}`,
      publishedAt: START,
      publishedBy: "u-owner",
      skills: "[]",
      workspaceId: WORKSPACE,
    });
  };
  await seedAgent(AGENT, options.fake ? "fake" : "cloud");
  const events = createEventsService({ blobs, db });
  const atomic = sqliteAtomic(db);
  const dispatched: string[] = [];
  /** A test sets `beforeStartRun` to act in the gap before a run is made. */
  const hooks: { beforeStartRun?: () => Promise<void> } = {};
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: (_db, run) => {
      dispatched.push(run.id);
      return Promise.resolve();
    },
    kind: "cloud",
    resume: () => Promise.resolve(),
  };
  // `tasks` and `requests` need `runs`, and `runs` needs the tasks gateway.
  let runs: ReturnType<typeof createRunsService>;
  let requests: ReturnType<typeof createRequestsService>;
  const tasks = createA2aTasksService({
    atomic,
    clock,
    db,
    events,
    requests: { answerAsPeer: (p, i) => requests.answerAsPeer(p, i) },
    runs: {
      cancelRun: (p, id) => runs.cancelRun(p, id),
      startRun: async (p, i, o) => {
        await hooks.beforeStartRun?.();
        return await runs.startRun(p, i, o);
      },
    },
    secretsKey: SECRETS_KEY,
  });
  runs = createRunsService({
    adapters: [adapter],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: options.fake === true,
    gateways: [tasks.gateway],
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: () => Promise.resolve(null) },
  });
  runs.onEvent(tasks.onEvent);
  events.onAppend(tasks.onEvent);
  const connections = createConnectionsService({
    atomic,
    clock,
    db,
    events,
    publicBaseUrl: "https://hm.test",
    secretsKey: SECRETS_KEY,
  });
  connections.onRevoked(tasks.onConnectionRevoked);

  /** An active inbound connection, with the default policies unless overridden. */
  const connect = async (
    overrides: Partial<typeof a2aConnections.$inferInsert> = {}
  ) => {
    const id = overrides.id ?? CONNECTION;
    await db.insert(a2aConnections).values({
      createdAt: START,
      createdBy: "u-owner",
      id,
      localAgentId: AGENT,
      peerKind: "a2a_inbound",
      peerLabel: "Hermes on Sam's box",
      slug: id,
      status: "active",
      workspaceId: WORKSPACE,
      ...overrides,
    });
    return id;
  };

  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    blobs,
    clock,
    connect,
    connections,
    db,
    dispatched,
    events,
    hooks,
    requests,
    runs,
    seedAgent,
    system: SYSTEM_PRINCIPAL,
    tasks,
  };
};

export type Fixture = Awaited<ReturnType<typeof createFixture>>;
