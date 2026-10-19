import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createAgentsService } from "@repo/services/agents";
import { createEventsService } from "@repo/services/events";
import type { NetworkRequestEntry } from "@repo/services/network";
import { createNetworkService } from "@repo/services/network";
import { systemClock } from "@repo/services/runs/types";
import { createSecretsService, type ProxyMatch } from "@repo/services/secrets";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { runWebFetcher } from "./run-fetcher.ts";

const RUN = { agentId: "agent-1", runId: "run-1", workspaceId: "ws-1" };
const KEY = "SK_TEST_VALUE_123";
const RULE: ProxyMatch = {
  header: "authorization",
  headerValue: `Bearer ${KEY}`,
  name: "API_KEY",
  value: KEY,
};

interface Announced {
  injection: { host: string; names: readonly string[]; via: string };
  run: unknown;
}

function harness() {
  const sent: Request[] = [];
  const announced: Announced[] = [];
  const recorded: { entry: NetworkRequestEntry; run: unknown }[] = [];
  const services = {
    network: {
      recordRequest: (run: unknown, entry: NetworkRequestEntry) => {
        recorded.push({ entry, run });
        return Promise.resolve();
      },
    },
    secrets: {
      announceInjection: (run: unknown, injection: Announced["injection"]) => {
        announced.push({ injection, run });
        return Promise.resolve();
      },
      proxyFor: (workspaceId: string, agentId: string, host: string) =>
        Promise.resolve(
          workspaceId === RUN.workspaceId &&
            agentId === RUN.agentId &&
            host === "api.example.com"
            ? [RULE]
            : []
        ),
    },
  } as unknown as Pick<Services, "network" | "secrets">;
  return { announced, recorded, sent, services };
}

const answer = () => new Response("ok", { status: 200 });

describe("runWebFetcher", () => {
  test("adds the rule header over https and announces the injection", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "web_fetch",
    });

    const result = await fetcher({ url: "https://api.example.com/v1/items" });

    expect(result.ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(h.announced).toEqual([
      {
        injection: {
          host: "api.example.com",
          names: ["API_KEY"],
          via: "web_fetch",
        },
        run: RUN,
      },
    ]);
  });

  test("sends a host with no rule without the header and without an announcement", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "curl",
    });

    const result = await fetcher({ url: "https://other.example.com/" });

    expect(result.ok).toBe(true);
    expect(h.sent[0]?.headers.get("authorization")).toBeNull();
    expect(h.announced).toEqual([]);
  });

  test("records each request with the run ids and the caller's via", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "curl",
    });

    await fetcher({ url: "https://other.example.com/" });
    await fetcher({ url: "http://127.0.0.1/" });

    expect(h.recorded.map((r) => r.run)).toEqual([RUN, RUN]);
    expect(h.recorded.map((r) => r.entry.via)).toEqual(["curl", "curl"]);
  });

  test("refuses a loopback address before it reaches fetch", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "web_fetch",
    });

    const result = await fetcher({ url: "http://127.0.0.1/" });

    expect(result.ok).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.recorded.map((r) => r.entry.via)).toEqual(["web_fetch"]);
  });

  test("the recorded entry holds no query string and no header value", async () => {
    const h = harness();
    const fetcher = runWebFetcher({
      fetch: (request) => {
        h.sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: RUN,
      services: h.services,
      via: "web_fetch",
    });

    await fetcher({
      headers: { "x-trace": "TRACE_HEADER_VALUE" },
      url: "https://api.example.com/v1/items?token=QUERY_SECRET_VALUE",
    });

    const entries = h.recorded.map((r) => r.entry);
    expect(entries.map((entry) => entry.host)).toEqual(["api.example.com"]);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("QUERY_SECRET_VALUE");
    expect(logged).not.toContain("TRACE_HEADER_VALUE");
    expect(logged).not.toContain(KEY);
  });
});

describe("runWebFetcher with env secrets, over real services", () => {
  const WORKSPACE = "w1";
  const START = "2026-10-19T10:00:00.000Z";
  const SECRET_NAME = "SUPADATA_KEY";
  const SECRET_VALUE = "sdt_live_0123456789abcdef";
  const PLACEHOLDER = `hm-secret:${SECRET_NAME}`;
  const SECRETS_KEY = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32))
  ).toString("base64");
  const user: Principal = {
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: WORKSPACE,
  };

  let db: ReturnType<typeof migrated>;
  let events: ReturnType<typeof createEventsService>;
  let secrets: ReturnType<typeof createSecretsService>;
  let network: ReturnType<typeof createNetworkService>;
  let agentA: string;
  let agentB: string;

  const seedRun = (agentId: string, runId: string) => {
    db.insert(sessionRows)
      .values({
        actorId: "u1",
        actorKind: "user",
        agentId,
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
        agentId,
        createdAt: START,
        id: runId,
        inputText: "hi",
        sessionId: `s-${runId}`,
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
  };

  const runOf = (agentId: string) => ({
    agentId,
    runId: `run-${agentId}`,
    workspaceId: WORKSPACE,
  });

  const fetcherFor = (
    agentId: string,
    sent: Request[],
    via: "curl" | "web_fetch" = "web_fetch"
  ) =>
    runWebFetcher({
      fetch: (request) => {
        sent.push(request);
        return Promise.resolve(answer());
      },
      ownHosts: [],
      run: runOf(agentId),
      services: { network, secrets },
      via,
    });

  const eventsOf = async (runId: string) =>
    await events.query(user, WORKSPACE, { runId });

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
    events = createEventsService({
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      db,
    });
    const agents = createAgentsService({ db, events });
    secrets = createSecretsService({
      atomic: sqliteAtomic(db),
      clock: systemClock,
      db,
      events,
      secretsKey: SECRETS_KEY,
    });
    network = createNetworkService({ db, events });
    agentA = (
      await agents.create(user, {
        model: "m",
        name: "Agent A",
        runtime: "fake",
      })
    ).id;
    agentB = (
      await agents.create(user, {
        model: "m",
        name: "Agent B",
        runtime: "fake",
      })
    ).id;
    seedRun(agentA, runOf(agentA).runId);
    seedRun(agentB, runOf(agentB).runId);
  });

  test("a granted placeholder goes out as the real value to an allowed host", async () => {
    const created = await secrets.create(user, {
      allowedHosts: ["api.supadata.ai"],
      mode: "env",
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });
    await secrets.setGrants(user, agentA, [created.id]);
    const sent: Request[] = [];

    const result = await fetcherFor(
      agentA,
      sent
    )({
      headers: { "x-api-key": PLACEHOLDER },
      url: "https://api.supadata.ai/v1/x",
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("x-api-key")).toBe(SECRET_VALUE);
  });

  test("the same placeholder to another host is refused and never sent", async () => {
    const created = await secrets.create(user, {
      allowedHosts: ["api.supadata.ai"],
      mode: "env",
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });
    await secrets.setGrants(user, agentA, [created.id]);
    const sent: Request[] = [];

    const result = await fetcherFor(
      agentA,
      sent
    )({
      headers: { "x-api-key": PLACEHOLDER },
      url: "https://example.com/",
    });

    expect(result).toMatchObject({ error: "blocked", ok: false });
    if (result.ok) {
      throw new Error("Expected the call to be refused");
    }
    expect(result.message).toContain(SECRET_NAME);
    expect(result.message).toContain("api.supadata.ai");
    expect(sent).toEqual([]);

    const refused = (await eventsOf(runOf(agentA).runId)).filter(
      (event) => event.type === "network.request"
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({
      blocked: expect.any(String),
      host: "example.com",
    });
    expect(JSON.stringify(refused)).not.toContain(SECRET_VALUE);
  });

  test("a secret granted only to another agent is refused for this agent", async () => {
    const created = await secrets.create(user, {
      allowedHosts: ["api.supadata.ai"],
      mode: "env",
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });
    await secrets.setGrants(user, agentB, [created.id]);
    const sent: Request[] = [];

    const result = await fetcherFor(
      agentA,
      sent
    )({
      headers: { "x-api-key": PLACEHOLDER },
      url: "https://api.supadata.ai/v1/x",
    });

    expect(result).toMatchObject({ error: "blocked", ok: false });
    if (result.ok) {
      throw new Error("Expected the call to be refused");
    }
    expect(result.message).toContain(SECRET_NAME);
    expect(sent).toEqual([]);
  });

  test("an env secret with no allowed hosts is refused with the Settings message", async () => {
    const created = await secrets.create(user, {
      mode: "env",
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });
    await secrets.setGrants(user, agentA, [created.id]);
    const sent: Request[] = [];

    const result = await fetcherFor(
      agentA,
      sent
    )({
      headers: { "x-api-key": PLACEHOLDER },
      url: "https://api.supadata.ai/v1/x",
    });

    expect(result).toMatchObject({ error: "blocked", ok: false });
    if (result.ok) {
      throw new Error("Expected the call to be refused");
    }
    expect(result.message).toContain("Add them in Settings, Secrets.");
    expect(sent).toEqual([]);
  });

  test("the injection event names the secret, the host and via, and no event of the run holds the value", async () => {
    const created = await secrets.create(user, {
      allowedHosts: ["api.supadata.ai"],
      mode: "env",
      name: SECRET_NAME,
      value: SECRET_VALUE,
    });
    await secrets.setGrants(user, agentA, [created.id]);
    const sent: Request[] = [];

    const result = await fetcherFor(
      agentA,
      sent,
      "curl"
    )({
      headers: { "x-api-key": PLACEHOLDER },
      url: "https://api.supadata.ai/v1/x",
    });
    expect(result.ok).toBe(true);

    const runEvents = await eventsOf(runOf(agentA).runId);
    const injected = runEvents.filter(
      (event) => event.type === "secret.injected"
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]?.payload).toMatchObject({
      host: "api.supadata.ai",
      names: [SECRET_NAME],
      via: "curl",
    });
    expect(runEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(runEvents)).not.toContain(SECRET_VALUE);
  });
});
