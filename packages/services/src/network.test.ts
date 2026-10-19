import { beforeEach, describe, expect, test } from "bun:test";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { createEventsService } from "./events.ts";
import { createNetworkService, type NetworkService } from "./network.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-17T10:00:00.000Z";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let agents: AgentsService;
let service: NetworkService;
let agentId: string;
const RUN = { runId: "r1", workspaceId: WORKSPACE };

/** A session and a run for the agent, so an event can point at them. */
const seedRun = (agent: string, runId: string) => {
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: agent,
      createdAt: START,
      id: `s-${runId}`,
      origin: "ui",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: agent,
      createdAt: START,
      id: runId,
      inputText: "hi",
      sessionId: `s-${runId}`,
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();
};

const networkEvents = () =>
  db
    .select()
    .from(eventRows)
    .all()
    .filter((event) => event.type === "network.request");

/** The one network event a test wrote. Fails the test when there is not exactly one. */
const onlyEvent = () => {
  const rows = networkEvents();
  const [event] = rows;
  if (!event || rows.length !== 1) {
    throw new Error(`Expected one network event, found ${rows.length}`);
  }
  return event;
};

const payloadOf = (event: { payload: string | null }) =>
  JSON.parse(event.payload ?? "{}") as Record<string, unknown>;

beforeEach(async () => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  const store = new Map<string, string>();
  const events = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    db,
  });
  agents = createAgentsService({ db, events });
  service = createNetworkService({ db, events });
  agentId = (
    await agents.create(user, { model: "m", name: "Agent", runtime: "fake" })
  ).id;
  seedRun(agentId, RUN.runId);
});

describe("recordRequest", () => {
  test("a 200 response writes one event with exactly the Log keys", async () => {
    await service.recordRequest(
      { agentId, ...RUN },
      {
        bytes: 12_595,
        durationMs: 140,
        host: "example.com",
        method: "GET",
        status: 200,
        via: "web_fetch",
      }
    );

    const event = onlyEvent();
    expect(Object.keys(payloadOf(event)).sort()).toEqual([
      "bytes",
      "durationMs",
      "host",
      "method",
      "status",
      "text",
      "via",
    ]);
    expect(payloadOf(event)).toEqual({
      bytes: 12_595,
      durationMs: 140,
      host: "example.com",
      method: "GET",
      status: 200,
      text: "GET example.com 200, 12.3 KB, 140 ms",
      via: "web_fetch",
    });
  });

  test("a refused request writes blocked and a null status", async () => {
    await service.recordRequest(
      { agentId, ...RUN },
      {
        blocked: "host is not on the allow list",
        bytes: 0,
        durationMs: 2,
        host: "evil.example",
        method: "POST",
        status: null,
        via: "curl",
      }
    );

    expect(payloadOf(onlyEvent())).toEqual({
      blocked: "host is not on the allow list",
      bytes: 0,
      durationMs: 2,
      host: "evil.example",
      method: "POST",
      status: null,
      text: "POST evil.example refused: host is not on the allow list",
      via: "curl",
    });
  });

  test("the event carries the run, agent, session and workspace ids", async () => {
    await service.recordRequest(
      { agentId, ...RUN },
      {
        bytes: 10,
        durationMs: 5,
        host: "example.com",
        method: "GET",
        status: 200,
        via: "curl",
      }
    );

    expect(onlyEvent()).toMatchObject({
      actorId: agentId,
      actorKind: "agent",
      agentId,
      runId: RUN.runId,
      sessionId: `s-${RUN.runId}`,
      workspaceId: WORKSPACE,
    });
  });

  test("fields beyond the entry shape never reach the payload", async () => {
    const leaky = {
      body: "request body",
      bytes: 1,
      durationMs: 1,
      headers: { authorization: "Bearer abc" },
      host: "example.com",
      method: "GET",
      path: "/secret/path?token=xyz",
      status: 200,
      via: "web_fetch",
    };
    await service.recordRequest(
      { agentId, ...RUN },
      leaky as unknown as Parameters<NetworkService["recordRequest"]>[1]
    );

    const event = onlyEvent();
    expect(Object.keys(payloadOf(event)).sort()).toEqual([
      "bytes",
      "durationMs",
      "host",
      "method",
      "status",
      "text",
      "via",
    ]);
    expect(event.payload).not.toContain("secret/path");
    expect(event.payload).not.toContain("request body");
    expect(event.payload).not.toContain("Bearer abc");
  });
});
