import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { file } from "bun";
import type { z } from "zod";
import {
  cancelSchema,
  claimResponseSchema,
  completeRequestSchema,
  completeResponseSchema,
  computerEnrollRequestSchema,
  createRequestBodySchema,
  createRequestResponseSchema,
  daemonFrameSchema,
  daemonHelloSchema,
  daemonPingSchema,
  enrollRequestSchema,
  enrollResponseSchema,
  eventsRequestSchema,
  eventsResponseSchema,
  FEATURE_LIBRARY_LIVE,
  FEATURE_REQUESTS,
  hasDaemonFeature,
  heartbeatResponseSchema,
  libraryChangedSchema,
  machineEnrollRequestSchema,
  offerSchema,
  relayFrameSchema,
  relayHelloAckSchema,
  rolesEnrollRequestSchema,
  rolesEnrollResponseSchema,
  waitRequestResponseSchema,
} from "./machine.ts";

const JSON_SUFFIX = /\.json$/;

const cases: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["enroll-request", enrollRequestSchema],
  ["enroll-response", enrollResponseSchema],
  ["enroll-request-roles", rolesEnrollRequestSchema],
  ["enroll-response-roles", rolesEnrollResponseSchema],
  ["hello", daemonHelloSchema],
  ["ping", daemonPingSchema],
  ["hello-ack", relayHelloAckSchema],
  ["offer", offerSchema],
  ["cancel", cancelSchema],
  ["library-changed", libraryChangedSchema],
  ["claim-response", claimResponseSchema],
  ["events-request", eventsRequestSchema],
  ["events-response", eventsResponseSchema],
  ["heartbeat-response", heartbeatResponseSchema],
  ["complete-request-done", completeRequestSchema],
  ["complete-request-failed", completeRequestSchema],
  ["complete-request-aborted", completeRequestSchema],
  ["complete-response", completeResponseSchema],
];

const daemonFixtures = ["hello", "ping"];
const relayFixtures = ["hello-ack", "offer", "cancel", "library-changed"];

const fixturesDir = new URL("../fixtures/", import.meta.url);

function loadFixture(name: string): Promise<unknown> {
  return file(new URL(`../fixtures/${name}.json`, import.meta.url)).json();
}

function loadFixtures(names: readonly string[]): Promise<unknown[]> {
  return Promise.all(names.map(loadFixture));
}

describe("machine protocol fixtures", () => {
  for (const [name, schema] of cases) {
    test(`${name} parses and round-trips`, async () => {
      const raw = await loadFixture(name);
      const parsed = schema.safeParse(raw);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual(raw);
    });

    test(`${name} rejects an unknown top-level field`, async () => {
      const raw = await loadFixture(name);
      const withExtra = { ...(raw as Record<string, unknown>), unexpected: 1 };
      expect(schema.safeParse(withExtra).success).toBe(false);
    });
  }

  test("hello rejects an unknown field in capabilities", async () => {
    const parsed = daemonHelloSchema.parse(await loadFixture("hello"));
    const nested = {
      ...parsed,
      capabilities: { ...parsed.capabilities, unexpected: 1 },
    };
    expect(daemonHelloSchema.safeParse(nested).success).toBe(false);
  });

  test("claim-response rejects an unknown field in run", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const nested = { ...parsed, run: { ...parsed.run, unexpected: 1 } };
    expect(claimResponseSchema.safeParse(nested).success).toBe(false);
  });

  test("events-request rejects an unknown field in an event", async () => {
    const parsed = eventsRequestSchema.parse(
      await loadFixture("events-request")
    );
    const nested = {
      events: parsed.events.map((event) => ({ ...event, unexpected: 1 })),
    };
    expect(eventsRequestSchema.safeParse(nested).success).toBe(false);
  });

  test("claim-response rejects a runToken without the hm_run_ prefix", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const wrongToken = {
      ...parsed,
      runToken: "hm_mach_7Fq2KxR9mWt4LpZc1Ns8VbYd",
    };
    expect(claimResponseSchema.safeParse(wrongToken).success).toBe(false);
  });

  test("claim-response rejects a null agent model", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const nullModel = { ...parsed, agent: { ...parsed.agent, model: null } };
    expect(claimResponseSchema.safeParse(nullModel).success).toBe(false);
  });

  test("claim-response accepts the library paths and conflicts, and rejects an unknown key in them", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const library = {
      conflicts: ["agents/ada/notes.md.conflict-r1"],
      paths: ["agents/ada"],
    };
    expect(claimResponseSchema.parse({ ...parsed, library }).library).toEqual(
      library
    );
    expect(parsed.library).toBeUndefined();
    expect(
      claimResponseSchema.safeParse({
        ...parsed,
        library: { ...library, extra: true },
      }).success
    ).toBe(false);
  });

  test("complete-request accepts a usage with only costUsd", async () => {
    const raw = (await loadFixture("complete-request-done")) as Record<
      string,
      unknown
    >;
    const withCostOnly = { ...raw, usage: { costUsd: 0.0123 } };
    expect(completeRequestSchema.safeParse(withCostOnly).success).toBe(true);
  });

  test("complete-request rejects an unknown field in usage", async () => {
    const raw = (await loadFixture("complete-request-done")) as Record<
      string,
      unknown
    >;
    const withExtra = {
      ...raw,
      usage: { costUsd: 0.0123, unexpected: 1 },
    };
    expect(completeRequestSchema.safeParse(withExtra).success).toBe(false);
  });

  test("a failed completion with a turn limit stop parses", async () => {
    const raw = (await loadFixture("complete-request-failed")) as Record<
      string,
      unknown
    >;
    const withStop = {
      ...raw,
      stop: { kind: "turn_limit", limit: 100 },
    };
    expect(completeRequestSchema.safeParse(withStop).success).toBe(true);
  });

  test("a failed completion with a repeat stop parses", async () => {
    const raw = (await loadFixture("complete-request-failed")) as Record<
      string,
      unknown
    >;
    const withStop = {
      ...raw,
      stop: { count: 5, kind: "repeat", tool: "Bash" },
    };
    expect(completeRequestSchema.safeParse(withStop).success).toBe(true);
  });

  test("a done completion with a stop is rejected", async () => {
    const raw = (await loadFixture("complete-request-done")) as Record<
      string,
      unknown
    >;
    const withStop = { ...raw, stop: { kind: "turn_limit", limit: 100 } };
    expect(completeRequestSchema.safeParse(withStop).success).toBe(false);
  });

  test("a failed completion with a bad stop is rejected", async () => {
    const raw = (await loadFixture("complete-request-failed")) as Record<
      string,
      unknown
    >;
    const badLimit = { ...raw, stop: { kind: "turn_limit", limit: 0 } };
    const badKind = { ...raw, stop: { kind: "budget", limit: 100 } };
    const extraField = {
      ...raw,
      stop: { kind: "turn_limit", limit: 100, unexpected: 1 },
    };
    expect(completeRequestSchema.safeParse(badLimit).success).toBe(false);
    expect(completeRequestSchema.safeParse(badKind).success).toBe(false);
    expect(completeRequestSchema.safeParse(extraField).success).toBe(false);
  });

  test("daemonFrameSchema accepts daemon frames and rejects relay frames", async () => {
    const daemonResults = (await loadFixtures(daemonFixtures)).map(
      (raw) => daemonFrameSchema.safeParse(raw).success
    );
    const relayResults = (await loadFixtures(relayFixtures)).map(
      (raw) => daemonFrameSchema.safeParse(raw).success
    );
    expect(daemonResults).toEqual(daemonFixtures.map(() => true));
    expect(relayResults).toEqual(relayFixtures.map(() => false));
  });

  test("relayFrameSchema accepts relay frames and rejects daemon frames", async () => {
    const relayResults = (await loadFixtures(relayFixtures)).map(
      (raw) => relayFrameSchema.safeParse(raw).success
    );
    const daemonResults = (await loadFixtures(daemonFixtures)).map(
      (raw) => relayFrameSchema.safeParse(raw).success
    );
    expect(relayResults).toEqual(relayFixtures.map(() => true));
    expect(daemonResults).toEqual(daemonFixtures.map(() => false));
  });

  test("cases cover every fixture file", () => {
    const onDisk = readdirSync(fixturesDir)
      .map((fileName) => fileName.replace(JSON_SUFFIX, ""))
      .sort();
    const listed = cases.map(([name]) => name).sort();
    expect(listed).toEqual(onDisk);
  });
});

describe("claim toolRules", () => {
  test("claim-response parses without toolRules and with them", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    expect(parsed.toolRules).toBeUndefined();
    const toolRules = ["Bash", "Edit"];
    expect(
      claimResponseSchema.parse({ ...parsed, toolRules }).toolRules
    ).toEqual(toolRules);
  });

  test("claim-response rejects toolRules that are not strings", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    expect(
      claimResponseSchema.safeParse({ ...parsed, toolRules: [1] }).success
    ).toBe(false);
  });
});

describe("requests feature", () => {
  test("hasDaemonFeature finds the requests feature in a header", () => {
    expect(hasDaemonFeature("library-sync,requests", FEATURE_REQUESTS)).toBe(
      true
    );
    expect(hasDaemonFeature("library-sync", FEATURE_REQUESTS)).toBe(false);
  });

  const approvalBody = {
    display: {
      input: { command: "ls" },
      summary: "List files",
      toolKey: "Bash",
      toolName: "Bash",
    },
    kind: "approval",
    toolName: "Bash",
    toolUseId: "toolu_01",
  };

  test("create body accepts a good approval and a good question", () => {
    expect(createRequestBodySchema.safeParse(approvalBody).success).toBe(true);
    const question = {
      display: {
        questions: [{ question: "Which branch?" }],
      },
      kind: "question",
      toolName: "AskUserQuestion",
      toolUseId: "toolu_02",
    };
    expect(createRequestBodySchema.safeParse(question).success).toBe(true);
  });

  test("create body rejects a missing toolUseId and an empty one", () => {
    const { toolUseId: _omitted, ...withoutId } = approvalBody;
    expect(createRequestBodySchema.safeParse(withoutId).success).toBe(false);
    expect(
      createRequestBodySchema.safeParse({ ...approvalBody, toolUseId: "" })
        .success
    ).toBe(false);
  });

  test("create response refuses an unknown status", () => {
    expect(
      createRequestResponseSchema.safeParse({
        requestId: "req_1",
        status: "pending",
      }).success
    ).toBe(true);
    expect(
      createRequestResponseSchema.safeParse({
        requestId: "req_1",
        status: "unknown",
      }).success
    ).toBe(false);
  });

  test("wait response accepts an answered outcome and refuses an unknown status", () => {
    const answered = {
      outcome: { answer: { decision: "allow_once" }, status: "answered" },
      status: "answered",
    };
    expect(waitRequestResponseSchema.safeParse(answered).success).toBe(true);
    expect(
      waitRequestResponseSchema.safeParse({ status: "unknown" }).success
    ).toBe(false);
  });
});

describe("library live feature", () => {
  test("hello parses with features and without them", async () => {
    const raw = (await loadFixture("hello")) as Record<string, unknown>;
    const withFeatures = { ...raw, features: [FEATURE_LIBRARY_LIVE] };
    expect(daemonHelloSchema.parse(withFeatures).features).toEqual([
      FEATURE_LIBRARY_LIVE,
    ]);
    expect(daemonHelloSchema.parse(raw).features).toBeUndefined();
  });

  test("claim-response parses a library without roots or taskFolder", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const library = { conflicts: [], paths: ["wiki"] };
    expect(claimResponseSchema.parse({ ...parsed, library }).library).toEqual(
      library
    );
  });

  test("claim-response accepts roots and a taskFolder", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const library = {
      conflicts: [],
      paths: ["wiki", "shared"],
      roots: [
        { mode: "read" as const, path: "wiki" },
        { mode: "write" as const, path: "shared" },
      ],
      taskFolder: "agents/ada/tasks/r1",
    };
    expect(claimResponseSchema.parse({ ...parsed, library }).library).toEqual(
      library
    );
  });

  test("claim-response rejects a root with an unknown mode", async () => {
    const parsed = claimResponseSchema.parse(
      await loadFixture("claim-response")
    );
    const library = {
      conflicts: [],
      paths: ["wiki"],
      roots: [{ mode: "admin", path: "wiki" }],
    };
    expect(claimResponseSchema.safeParse({ ...parsed, library }).success).toBe(
      false
    );
  });

  test("hasDaemonFeature finds the library-live feature in a header", () => {
    expect(
      hasDaemonFeature("library-sync, library-live", FEATURE_LIBRARY_LIVE)
    ).toBe(true);
  });
});

describe("hasDaemonFeature", () => {
  test("finds a feature among several, with spaces around it", () => {
    expect(hasDaemonFeature("a, library-sync ,b", "library-sync")).toBe(true);
    expect(hasDaemonFeature("library-sync", "library-sync")).toBe(true);
  });

  test("is false for a missing or empty header and for a different name", () => {
    expect(hasDaemonFeature(undefined, "library-sync")).toBe(false);
    expect(hasDaemonFeature(null, "library-sync")).toBe(false);
    expect(hasDaemonFeature("", "library-sync")).toBe(false);
    expect(hasDaemonFeature("library-sync-v2", "library-sync")).toBe(false);
  });
});

describe("message.reasoning events", () => {
  test("the daemon's upload accepts a reasoning event", () => {
    const parsed = eventsRequestSchema.safeParse({
      events: [{ payload: { text: "hm" }, seq: 1, type: "message.reasoning" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("computer enrol request", () => {
  const computerBody = {
    arch: "arm64",
    clientVersion: "0.1.0",
    code: "hm_enr_abc",
    hostname: "dom-mac",
    os: "darwin",
    role: "computer",
  };

  test("a computer body parses with the computer schema and the union", () => {
    expect(computerEnrollRequestSchema.safeParse(computerBody).success).toBe(
      true
    );
    expect(machineEnrollRequestSchema.safeParse(computerBody).success).toBe(
      true
    );
  });

  test("the daemon body still parses through the union", () => {
    const daemonBody = { code: "hm_enr_abc", singleUser: false };
    expect(machineEnrollRequestSchema.safeParse(daemonBody).success).toBe(true);
    expect(computerEnrollRequestSchema.safeParse(daemonBody).success).toBe(
      false
    );
  });

  test("the role must be computer and fields are strict", () => {
    for (const body of [
      { ...computerBody, role: "agent_host" },
      { ...computerBody, extra: 1 },
      { ...computerBody, clientVersion: undefined },
      { ...computerBody, code: "nope" },
    ]) {
      expect(machineEnrollRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("roles enrol request", () => {
  test("roles are optional and may name one or both, in either order", async () => {
    const raw = (await loadFixture("enroll-request-roles")) as Record<
      string,
      unknown
    >;
    const { roles: _roles, ...withoutRoles } = raw;
    for (const body of [
      withoutRoles,
      { ...raw, roles: ["computer"] },
      { ...raw, roles: ["agent_host"] },
      { ...raw, roles: ["computer", "agent_host"] },
    ]) {
      expect(body).toEqual(machineEnrollRequestSchema.parse(body));
    }
  });

  test("empty, duplicate, unknown roles and non-Go platform names are refused", async () => {
    const raw = (await loadFixture("enroll-request-roles")) as Record<
      string,
      unknown
    >;
    for (const fields of [
      { roles: [] },
      { roles: ["computer", "computer"] },
      { roles: ["both"] },
      { arch: "x86_64" },
      { os: "Linux" },
      { singleUser: undefined },
    ]) {
      expect(
        machineEnrollRequestSchema.safeParse({ ...raw, ...fields }).success
      ).toBe(false);
    }
  });
});
