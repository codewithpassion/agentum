import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { file } from "bun";
import type { z } from "zod";
import {
  cancelSchema,
  claimResponseSchema,
  completeRequestSchema,
  completeResponseSchema,
  daemonFrameSchema,
  daemonHelloSchema,
  daemonPingSchema,
  enrollRequestSchema,
  enrollResponseSchema,
  eventsRequestSchema,
  eventsResponseSchema,
  hasDaemonFeature,
  heartbeatResponseSchema,
  offerSchema,
  relayFrameSchema,
  relayHelloAckSchema,
} from "./machine.ts";

const JSON_SUFFIX = /\.json$/;

const cases: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["enroll-request", enrollRequestSchema],
  ["enroll-response", enrollResponseSchema],
  ["hello", daemonHelloSchema],
  ["ping", daemonPingSchema],
  ["hello-ack", relayHelloAckSchema],
  ["offer", offerSchema],
  ["cancel", cancelSchema],
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
const relayFixtures = ["hello-ack", "offer", "cancel"];

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
