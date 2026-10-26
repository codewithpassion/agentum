import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import type { StreamFrame } from "@repo/protocol/stream";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal, Workspace } from "@repo/services/workspaces";
import { type Composed, composeWith, type Infra } from "./compose.ts";
import {
  deskStreamName,
  STREAM_EVENT_TYPES,
  TASK_EVENT_TYPES,
} from "./session-stream-frames.ts";
import type { SessionStreamPort } from "./session-stream-port.ts";

type User = Extract<Principal, { kind: "user" }>;

let db: ReturnType<typeof migrated>;
let composed: Composed;
let user: User;
let agentId: string;
let seedSession: string;
let published: { sessionId: string; frame: StreamFrame }[];
let portFails = false;
let posted: { body: unknown; headers: Headers; url: string }[];

const port: SessionStreamPort = {
  publish: (sessionId, frame) => {
    if (portFails) {
      return Promise.reject(new Error("stream is down"));
    }
    published.push({ frame, sessionId });
    return Promise.resolve();
  },
};

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: false,
    fetch: (url, init) => {
      posted.push({
        body: JSON.parse(String(init?.body ?? "null")),
        headers: new Headers(init?.headers),
        url: String(url),
      });
      return Promise.resolve(new Response("{}", { status: 202 }));
    },
    fileBlobs: {
      delete: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
    relay: noopRelay,
    secretsKey: Buffer.from(
      crypto.getRandomValues(new Uint8Array(32))
    ).toString("base64"),
    streams: port,
  };
};

beforeEach(async () => {
  db = migrated();
  published = [];
  posted = [];
  portFails = false;
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: infra(),
  });
  const workspace: Workspace | null = await composed.services.workspaces.forOrg(
    { clerkOrgId: "org_a" }
  );
  if (!workspace) {
    throw new Error("org_a must be allowed");
  }
  user = {
    kind: "user",
    userId: "user_a",
    via: "session",
    workspaceId: workspace.id,
  };
  // A session exists only once a run starts, and events may not point at a missing one.
  const { machineId } = await composed.services.machines
    .createEnrollToken(user, { machineName: "m1" })
    .then(({ code }) =>
      composed.services.machines.enroll({ code, singleUser: false })
    )
    .then((enrolled) => {
      if (!enrolled) {
        throw new Error("enrol failed");
      }
      return enrolled;
    });
  agentId = (
    await composed.services.agents.create(user, {
      machineId,
      model: "m",
      name: "Spy",
      runtime: "machine",
    })
  ).id;
  ({ sessionId: seedSession } = await composed.services.runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  }));
  published = [];
});

const appendEvent = (
  type: "agent.created" | "tool.call",
  payload: Record<string, unknown>,
  sessionId: string | null
) =>
  composed.services.events.append({
    actor: { id: user.userId, kind: "user" },
    payload,
    sessionId,
    type,
    workspaceId: user.workspaceId,
  });

test("a stored event reaches the port as an event frame with the stored payload", async () => {
  const record = await appendEvent(
    "tool.call",
    { input: { password: "hunter2" }, name: "bash", toolUseId: "t1" },
    seedSession
  );

  expect(published).toEqual([
    {
      frame: {
        actor: record.actor,
        createdAt: record.createdAt,
        frame: "event",
        id: record.id,
        payload: record.payload,
        runId: null,
        seq: null,
        type: "tool.call",
      },
      sessionId: seedSession,
    },
  ]);
});

test("the streamed payload is the redacted one, and the raw secret is nowhere in the frames", async () => {
  const record = await appendEvent(
    "tool.call",
    { input: { password: "hunter2" }, name: "bash", toolUseId: "t1" },
    seedSession
  );

  expect(record.payload).toMatchObject({ input: { password: "[redacted]" } });
  expect(published[0]?.frame).toMatchObject({ payload: record.payload });
  expect(JSON.stringify(published)).not.toContain("hunter2");
});

test("an event without a session publishes nothing", async () => {
  await appendEvent("tool.call", { name: "bash", toolUseId: "t1" }, null);

  expect(published).toEqual([]);
});

test("an event type the stream does not carry publishes nothing", async () => {
  await appendEvent("agent.created", { name: "Agent" }, seedSession);

  expect(published).toEqual([]);
});

test("starting a run publishes its queued event, its run frame, then the user message", async () => {
  const { runId } = await composed.services.runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  });

  const queued = [
    expect.objectContaining({ frame: "event", runId, type: "run.queued" }),
    { frame: "run", runId, status: "queued" },
  ];
  const onDesk = deskStreamName(user.workspaceId);
  expect(
    published
      .filter(({ sessionId }) => sessionId !== onDesk)
      .map(({ frame }) => frame)
  ).toEqual([
    ...queued,
    expect.objectContaining({ frame: "event", runId, type: "message.user" }),
  ]);
  // The workspace's desk instance gets the run frames, not the message.
  expect(
    published
      .filter(({ sessionId }) => sessionId === onDesk)
      .map(({ frame }) => frame)
  ).toEqual(queued);
});

test("a port that rejects does not fail the append", async () => {
  portFails = true;

  const record = await appendEvent(
    "tool.call",
    { name: "bash", toolUseId: "t1" },
    seedSession
  );

  expect(record.type).toBe("tool.call");
  expect(published).toEqual([]);
});

const INCIDENT = "inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2";

/** Grants the agent the investigator's ingest token, a proxy secret for the control-plane host. */
const grantIngestToken = async () => {
  const secret = await composed.services.secrets.create(user, {
    mode: "proxy",
    name: "CONTROL_PLANE_INGEST_TOKEN",
    rules: [
      {
        header: "Authorization",
        host: "cp.example.com",
        template: "Bearer {value}",
      },
    ],
    value: "cpt_test_token_0123456789",
  });
  await composed.services.secrets.setGrants(user, agentId, [secret.id]);
};

/** control-plane sends its approval id as the request id, and the incident id in the prompt. */
const startAndCancel = async (
  requestId: string,
  text = `Investigate incident ${INCIDENT} on billing`
) => {
  const { runId } = await composed.services.runs.startRun(user, {
    agentId,
    input: { text },
    requestId,
    session: { origin: "trigger" },
  });
  await composed.services.runs.cancelRun(user, runId);
  return runId;
};

test("a cancelled trigger run of an incident tells control-plane to escalate, with the token added", async () => {
  await grantIngestToken();

  const runId = await startAndCancel(
    "trigger:trg1:apr_01HZX3Y5N7Q9R2T4V6W8A0B1C2"
  );

  expect(posted).toHaveLength(1);
  expect(posted[0]?.url).toBe("https://cp.example.com/ingest/events");
  expect(posted[0]?.headers.get("authorization")).toBe(
    "Bearer cpt_test_token_0123456789"
  );
  expect(posted[0]?.body).toMatchObject({
    correlation_id: INCIDENT,
    payload: { incidentId: INCIDENT, outcome: "escalate", runId },
    source: "agent",
    type: "investigation.result",
  });
});

test("a cancelled run that no trigger started, or whose prompt names no incident, posts nothing", async () => {
  await grantIngestToken();

  await startAndCancel("plain-request-id");
  await startAndCancel(
    "trigger:trg1:apr_01HZX3Y5N7Q9R2T4V6W8A0B1C3",
    "Investigate the billing job"
  );

  expect(posted).toEqual([]);
});

test("a cancelled incident run of an agent without the ingest token posts nothing", async () => {
  await startAndCancel("trigger:trg1:apr_01HZX3Y5N7Q9R2T4V6W8A0B1C2");

  expect(posted).toEqual([]);
});

/** A trigger run that the system claims, then ends `done`, with the tool results it printed first. */
const finishTriggerRun = async (requestId: string, outputs: string[]) => {
  const system: Principal = { kind: "system" };
  const { runId } = await composed.services.runs.startRun(user, {
    agentId,
    input: { text: `Investigate incident ${INCIDENT} on billing` },
    requestId,
    session: { origin: "trigger" },
  });
  await composed.services.runs.claimRun(system, runId);
  await composed.services.runs.ingestRunEvents(
    system,
    runId,
    outputs.map((output, index) => ({
      payload: { ok: true, output, toolUseId: `t${index}` },
      seq: index + 1,
      type: "tool.result",
    }))
  );
  await composed.services.runs.completeRun(system, runId, {
    status: "done",
    text: "ok",
  });
  return runId;
};

test("a trigger run that finished without reporting tells control-plane to escalate", async () => {
  await grantIngestToken();

  const runId = await finishTriggerRun(
    "trigger:trg1:apr_01HZX3Y5N7Q9R2T4V6W8A0B1C2",
    ["step posted"]
  );

  expect(posted).toHaveLength(1);
  expect(posted[0]?.body).toMatchObject({
    payload: { incidentId: INCIDENT, outcome: "escalate", runId },
    type: "investigation.result",
  });
});

test("a trigger run that finished after it reported posts nothing more", async () => {
  await grantIngestToken();

  await finishTriggerRun("trigger:trg1:apr_01HZX3Y5N7Q9R2T4V6W8A0B1C2", [
    `reported fixed for ${INCIDENT}: HTTP 202`,
  ]);

  expect(posted).toEqual([]);
});

test("the task view carries connector events, and the stream's own types stay without them", async () => {
  const { runId, sessionId } = await composed.services.runs.startRun(user, {
    agentId,
    input: { text: "hello" },
    session: { origin: "ui" },
  });
  const append = (type: "connector.call" | "connector.timeout") =>
    composed.services.events.append({
      actor: { id: user.userId, kind: "user" },
      payload: { ok: false },
      runId,
      sessionId,
      type,
      workspaceId: user.workspaceId,
    });
  await append("connector.call");
  await append("connector.timeout");

  const view = await composed.services.tasks.get(user, { runId });

  expect(view.events.map(({ type }) => type)).toEqual(
    expect.arrayContaining(["connector.call", "connector.timeout"])
  );
  expect(TASK_EVENT_TYPES).toEqual(
    expect.arrayContaining([
      ...STREAM_EVENT_TYPES,
      "connector.call",
      "connector.needs_auth",
      "connector.timeout",
    ])
  );
  expect(STREAM_EVENT_TYPES.some((t) => t.startsWith("connector."))).toBe(
    false
  );
  expect(published.map(({ frame }) => frame)).not.toContainEqual(
    expect.objectContaining({ type: "connector.call" })
  );
});
