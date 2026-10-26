import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { createAgentsService } from "./agents.ts";
import { createEventsService, type EventRecord } from "./events.ts";
import {
  createInvestigatorReportBack,
  createRequestIdReader,
  escalationEvent,
  INGEST_PATH,
  INGEST_TOKEN_SECRET,
  incidentIdOf,
} from "./investigator-report.ts";
import type { Principal } from "./workspaces.ts";

type Deps = Parameters<typeof createInvestigatorReportBack>[0];
type Secrets = Deps["secrets"];

const WORKSPACE = "w1";
const START = "2026-10-17T10:00:00.000Z";
const NOW = new Date("2026-10-17T11:00:00.000Z");
const AGENT = "ag-investigator";
const RUN = "run-1";
const INCIDENT = "inc_01HZ8Q3M5V7W9XBCDFGJKMNPQR";
const TRIGGER_REQUEST = `trigger:trg_1:${INCIDENT}`;
const INGEST_HOST = "control.example.com";
const INGEST_TOKEN = "ingest-token-0123456789";
const MASK = `[secret:${INGEST_TOKEN_SECRET}]`;
const EMOJI = "\u{1F600}";

const eventOf = (
  type: EventRecord["type"],
  payload: EventRecord["payload"] = {},
  overrides: Partial<EventRecord> = {}
): EventRecord => ({
  actor: { id: AGENT, kind: "system" },
  agentId: AGENT,
  createdAt: START,
  id: `evt-${type}`,
  payload,
  payloadRef: null,
  runId: RUN,
  seq: null,
  sessionId: "session-1",
  type,
  workspaceId: WORKSPACE,
  ...overrides,
});

/** Secrets for an agent that has the ingest token, with the given hosts on its rule. */
const secretsWith = ({
  hosts = [INGEST_HOST],
  granted = true,
}: {
  hosts?: string[];
  granted?: boolean;
} = {}): Secrets => ({
  proxyFor: (_workspaceId, _agentId, host) =>
    Promise.resolve(
      granted && host === INGEST_HOST
        ? [
            {
              header: "Authorization",
              headerValue: `Bearer ${INGEST_TOKEN}`,
              name: INGEST_TOKEN_SECRET,
              value: INGEST_TOKEN,
            },
          ]
        : []
    ),
  resolveForAgent: () =>
    Promise.resolve({
      env: {},
      masker: createMasker({ [INGEST_TOKEN_SECRET]: INGEST_TOKEN }),
      proxy: granted ? [{ hosts, name: INGEST_TOKEN_SECRET }] : [],
      revision: "rev-1",
    }),
});

interface FetchCall {
  init: RequestInit;
  url: string;
}

const bodyOf = (call: FetchCall): Record<string, unknown> =>
  JSON.parse(String(call.init.body));

let messages: string[];

beforeEach(() => {
  messages = [];
  spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  mock.restore();
});

/** Builds the report with a recording fetch that answers `status`, or rejects when `rejects` is set. */
const harness = ({
  defer,
  rejects,
  requestId = TRIGGER_REQUEST,
  secrets = secretsWith(),
  status = 202,
}: {
  defer?: Deps["defer"];
  rejects?: Error;
  requestId?: string | null;
  secrets?: Secrets;
  status?: number;
} = {}) => {
  const calls: FetchCall[] = [];
  const report = createInvestigatorReportBack({
    defer,
    fetch: (url, init) => {
      calls.push({ init, url });
      return rejects
        ? Promise.reject(rejects)
        : Promise.resolve(new Response(null, { status }));
    },
    now: () => NOW,
    requestIdOf: async () => requestId,
    secrets,
  });
  return { calls, report };
};

describe("incidentIdOf", () => {
  test("gives the incident id of a trigger request id", () => {
    expect(incidentIdOf(TRIGGER_REQUEST)).toBe(INCIDENT);
  });

  test("gives null for another prefix, a null id or a bad incident id", () => {
    expect(incidentIdOf(`run:trg_1:${INCIDENT}`)).toBeNull();
    expect(incidentIdOf("trigger:trg_1:inc_short")).toBeNull();
    expect(incidentIdOf(`trigger:trg_1:inc_${"I".repeat(26)}`)).toBeNull();
    expect(incidentIdOf(null)).toBeNull();
  });
});

describe("escalationEvent", () => {
  test("builds the exact envelope without an error", () => {
    expect(
      escalationEvent({
        error: null,
        incidentId: INCIDENT,
        now: NOW,
        runId: RUN,
        status: "failed",
      })
    ).toEqual({
      actor: { id: "harbourmaster-investigator", kind: "agent" },
      correlation_id: INCIDENT,
      fingerprint: `hm-investigator:${INCIDENT}`,
      payload: {
        incidentId: INCIDENT,
        outcome: "escalate",
        runId: RUN,
        steps: ["The run ended without reporting a result."],
        summary: "The investigator run ended failed before it reported.",
      },
      severity: "info",
      source: "agent",
      summary: "The investigator run ended failed before it reported.",
      system_id: null,
      ts: "2026-10-17T11:00:00.000Z",
      type: "investigation.result",
    });
  });

  test("adds the error to the text and to a step", () => {
    const event = escalationEvent({
      error: "boom",
      incidentId: INCIDENT,
      now: NOW,
      runId: RUN,
      status: "interrupted",
    });
    const sentence =
      "The investigator run ended interrupted before it reported.";
    expect(event.summary).toBe(`${sentence} Error: boom`);
    expect(event.payload).toMatchObject({
      steps: ["The run ended without reporting a result.", "Error: boom"],
      summary: `${sentence} Error: boom`,
    });
  });

  test("collapses newlines and control characters in the envelope summary only", () => {
    const event = escalationEvent({
      error: "a\n\tb\u0000c",
      incidentId: INCIDENT,
      now: NOW,
      runId: RUN,
      status: "cancelled",
    });
    expect(event.summary).toBe(
      "The investigator run ended cancelled before it reported. Error: a bc"
    );
    expect(event.payload).toMatchObject({
      steps: [
        "The run ended without reporting a result.",
        "Error: a\n\tb\u0000c",
      ],
    });
  });

  test("cuts the envelope summary to 200 code points", () => {
    const head =
      "The investigator run ended failed before it reported. Error: ";
    const event = escalationEvent({
      error: EMOJI.repeat(500),
      incidentId: INCIDENT,
      now: NOW,
      runId: RUN,
      status: "failed",
    });
    expect(event.summary).toBe(
      `${head}${EMOJI.repeat(200 - Array.from(head).length)}`
    );
  });

  test("cuts the payload summary to 2000 and each step to 500 code points", () => {
    const event = escalationEvent({
      error: "x".repeat(3000),
      incidentId: INCIDENT,
      now: NOW,
      runId: RUN,
      status: "failed",
    });
    const payload = event.payload as {
      steps: string[];
      summary: string;
    };
    expect(Array.from(payload.summary)).toHaveLength(2000);
    expect(payload.steps[1]).toBe(`Error: ${"x".repeat(493)}`);
  });
});

describe("onEvent", () => {
  test.each([
    ["run.failed", "failed"],
    ["run.cancelled", "cancelled"],
    ["run.interrupted", "interrupted"],
  ] as const)("posts once for %s", async (type, status) => {
    const { calls, report } = harness();
    await report.onEvent(eventOf(type, { error: "bad" }));

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`https://${INGEST_HOST}${INGEST_PATH}`);
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe(`Bearer ${INGEST_TOKEN}`);
    expect(call ? bodyOf(call) : null).toEqual(
      escalationEvent({
        error: "bad",
        incidentId: INCIDENT,
        now: NOW,
        runId: RUN,
        status,
      })
    );
  });

  test("ignores other event types", async () => {
    const { calls, report } = harness();
    await report.onEvent(eventOf("run.finished"));
    await report.onEvent(eventOf("run.started"));
    await report.onEvent(eventOf("tool.call", { name: "bash" }));
    expect(calls).toHaveLength(0);
  });

  test("ignores events without a run or an agent", async () => {
    const { calls, report } = harness();
    await report.onEvent(eventOf("run.failed", {}, { runId: null }));
    await report.onEvent(eventOf("run.failed", {}, { agentId: null }));
    expect(calls).toHaveLength(0);
  });

  test.each([null, "trigger:trg_1:req-42"])(
    "does nothing when the request id is %p",
    async (requestId) => {
      const { calls, report } = harness({ requestId });
      await report.onEvent(eventOf("run.failed"));
      expect(calls).toHaveLength(0);
    }
  );

  test("does nothing when the agent has no ingest token", async () => {
    const { calls, report } = harness({
      secrets: secretsWith({ granted: false }),
    });
    await report.onEvent(eventOf("run.failed"));
    expect(calls).toHaveLength(0);
  });

  test("does nothing when the only host is a wildcard", async () => {
    const { calls, report } = harness({
      secrets: secretsWith({ hosts: ["*.example.com"] }),
    });
    await report.onEvent(eventOf("run.failed"));
    expect(calls).toHaveLength(0);
  });

  test("uses the first host that is not a wildcard", async () => {
    const { calls, report } = harness({
      secrets: secretsWith({ hosts: ["*.example.com", INGEST_HOST] }),
    });
    await report.onEvent(eventOf("run.failed"));
    expect(calls.map((call) => call.url)).toEqual([
      `https://${INGEST_HOST}${INGEST_PATH}`,
    ]);
  });

  test("hands the work to defer when given", async () => {
    const deferred: Promise<void>[] = [];
    const { calls, report } = harness({
      defer: (work) => {
        deferred.push(work);
      },
    });
    await report.onEvent(eventOf("run.failed"));
    expect(deferred).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await Promise.all(deferred);
    expect(calls).toHaveLength(1);
  });

  test("does not throw when fetch rejects, and warns with the error name only", async () => {
    const { report } = harness({
      rejects: new TypeError("network down at control.example.com"),
    });
    await report.onEvent(eventOf("run.failed"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(RUN);
    expect(messages[0]).toContain("TypeError");
    expect(messages[0]).not.toContain("network down");
  });

  test("does not throw when the answer is 500, and warns with the status", async () => {
    const { report } = harness({ status: 500 });
    await report.onEvent(eventOf("run.failed"));
    expect(messages).toEqual([
      `Investigator report for run ${RUN} got HTTP 500`,
    ]);
  });

  test("masks the secret in the error text", async () => {
    const { calls, report } = harness();
    await report.onEvent(
      eventOf("run.failed", { error: `leaked ${INGEST_TOKEN} here` })
    );
    const [call] = calls;
    const text = call?.init.body;
    expect(String(text)).not.toContain(INGEST_TOKEN);
    expect(String(text)).toContain(`Error: leaked ${MASK} here`);
  });
});

describe("createRequestIdReader", () => {
  let db: ReturnType<typeof migrated>;

  const seed = async () => {
    db = migrated();
    for (const id of [WORKSPACE, "w2"]) {
      db.insert(workspaces)
        .values({
          clerkOrgId: `org_${id}`,
          createdAt: START,
          id,
          name: id,
          timezone: "UTC",
        })
        .run();
    }
    const events = createEventsService({
      blobs: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
      },
      db,
    });
    const agents = createAgentsService({ db, events });
    const principal: Principal = {
      kind: "user",
      userId: "u1",
      via: "session",
      workspaceId: WORKSPACE,
    };
    const agent = await agents.create(principal, {
      model: "m",
      name: "Investigator",
      runtime: "fake",
    });
    db.insert(sessionRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId: agent.id,
        createdAt: START,
        id: "s1",
        origin: "ui",
        workspaceId: WORKSPACE,
      })
      .run();
    db.insert(runRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId: agent.id,
        createdAt: START,
        id: RUN,
        inputText: "hi",
        requestId: TRIGGER_REQUEST,
        sessionId: "s1",
        status: "failed",
        workspaceId: WORKSPACE,
      })
      .run();
    return db;
  };

  test("reads the request id of a run in its workspace only", async () => {
    await seed();
    const read = createRequestIdReader(db);
    expect(await read(WORKSPACE, RUN)).toBe(TRIGGER_REQUEST);
    expect(await read("w2", RUN)).toBeNull();
    expect(await read(WORKSPACE, "missing")).toBeNull();
  });
});
