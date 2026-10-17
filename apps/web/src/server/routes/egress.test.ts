import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { managedSessions } from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import type { Fetcher } from "@repo/services/connectors/mcp";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import {
  importRunTokenKey,
  signRunToken,
  signSessionToken,
} from "@repo/services/run-tokens";
import type { Clock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import { egressRoutes, MAX_EGRESS_BODY_BYTES } from "./egress.ts";
import type { AppEnv } from "./groups.ts";

const WORKSPACE = "w1";
const START_MS = Date.parse("2026-10-16T10:00:00.000Z");
const MINUTE_MS = 60_000;
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const env = { RUN_TOKEN_KEY } as unknown as Env;
const DOM = "user_dom";
const CAP_MS = 5000;
const HOST = "api.example.com";
const SECRET_NAME = "EXAMPLE_KEY";
/** Fake values: shaped like keys, never real. */
const SECRET_VALUE = "sk_fake_relay_0001";
const CLIENT_TOKEN_HEADER = "Bearer client-side-token";

const dom: Principal = {
  kind: "user",
  userId: DOM,
  via: "session",
  workspaceId: WORKSPACE,
};

interface Sent {
  body: string | null;
  headers: Headers;
  method: string;
  url: string;
}

let db: ReturnType<typeof migrated>;
let composed: Composed;
let app: Hono<AppEnv>;
let nowMs: number;
let agentId: string;
let otherAgentId: string;
let sent: Sent[];
let logged: Record<string, unknown>[];
/** What the fake host answers. Set per test. */
let upstream: (init: RequestInit, url: string) => Promise<Response>;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.min(ms, 5));
    }),
};

/** Records each call and answers it with `upstream`. Never touches the network. */
const fakeHost: Fetcher = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.toString();
  const body =
    init.body === undefined || init.body === null
      ? null
      : new TextDecoder().decode(init.body as Uint8Array);
  sent.push({
    body,
    headers: new Headers(init.headers),
    method: String(init.method),
    url,
  });
  return await upstream(init, url);
};

const addRun = (
  id: string,
  owner: string,
  status: "done" | "interrupted" | "running" = "running"
) => {
  const now = new Date(nowMs).toISOString();
  db.insert(sessions)
    .values({
      actorId: DOM,
      actorKind: "user",
      agentId: owner,
      createdAt: now,
      externalKey: `session_${id}`,
      id: `session_${id}`,
      origin: "mcp",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(runs)
    .values({
      actorId: DOM,
      actorKind: "user",
      agentId: owner,
      createdAt: now,
      id,
      inputText: "work",
      leaseUntil: new Date(nowMs + 30 * MINUTE_MS).toISOString(),
      onBehalfOfUserId: DOM,
      sessionId: `session_${id}`,
      status,
      workspaceId: WORKSPACE,
    })
    .run();
};

const tokenFor = async (runId: string, owner = agentId) =>
  signRunToken(await importRunTokenKey(RUN_TOKEN_KEY), {
    agentId: owner,
    issuedAt: nowMs,
    runId,
    workspaceId: WORKSPACE,
  });

/** An agent-side call to the relay. `path` is appended to `/api/egress/<host>`. */
const relay = (
  token: string | null,
  {
    body,
    host = HOST,
    method = "GET",
    path = "/v1/items",
  }: { body?: string; host?: string; method?: string; path?: string } = {}
) =>
  app.request(
    `https://hm.example/api/egress/${host}${path}`,
    {
      body,
      headers: {
        Authorization: token === null ? "" : `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-Forwarded-For": "203.0.113.9",
      },
      method,
    },
    env
  );

const eventsOf = async (runId: string) =>
  (await db.select().from(events).where(eq(events.runId, runId))).filter(
    (row) => row.type.startsWith("secret.")
  );

const grantedAgent = async (owner = agentId) => {
  const created = await composed.services.secrets.create(dom, {
    mode: "proxy",
    name: SECRET_NAME,
    rules: [
      { header: "Authorization", host: HOST, template: "Bearer {value}" },
    ],
    value: SECRET_VALUE,
  });
  await composed.services.secrets.setGrants(dom, owner, [created.id]);
  return created;
};

/** The relay on an app that supplies `composed` the way server.ts does. */
const mount = (capMs = CAP_MS) => {
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    "/api/egress",
    egressRoutes({
      capMs,
      fetch: fakeHost,
      log: (entry) => {
        logged.push(entry);
      },
    })
  );
};

const answerWith =
  (status: number, text: string, type = "application/json") =>
  (): Promise<Response> =>
    Promise.resolve(
      new Response(text, { headers: { "Content-Type": type }, status })
    );

beforeEach(async () => {
  db = migrated();
  nowMs = START_MS;
  sent = [];
  logged = [];
  upstream = answerWith(200, '{"ok":true}');
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: new Date(nowMs).toISOString(),
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_w1"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock,
      devFakeRuntime: true,
      fetch: fakeHost,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
      runTokenKey: RUN_TOKEN_KEY,
      secretsKey: SECRETS_KEY,
    },
  });
  agentId = (
    await composed.services.agents.create(dom, {
      model: "fake",
      name: "Bruce",
      runtime: "fake",
      slug: "bruce",
    })
  ).id;
  otherAgentId = (
    await composed.services.agents.create(dom, {
      model: "fake",
      name: "Dora",
      runtime: "fake",
      slug: "dora",
    })
  ).id;
  mount();
});

describe("the gate", () => {
  test("no token and a forged token get 401, and the host is never called", async () => {
    await grantedAgent();
    addRun("run_1", agentId);

    expect((await relay(null)).status).toBe(401);
    expect((await relay("hm_run_forged.sig")).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("the 401 carries the same WWW-Authenticate header as the proxy", async () => {
    const response = await relay(null);

    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="harbourmaster"'
    );
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("a run that is no longer running gets 401", async () => {
    await grantedAgent();
    addRun("run_done", agentId, "done");

    expect((await relay(await tokenFor("run_done"))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("a host the agent holds no rule for gets 403 with no upstream call and a denial logged", async () => {
    addRun("run_1", agentId);
    await grantedAgent();

    const response = await relay(await tokenFor("run_1"), {
      host: "other.example.org",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "host_not_granted",
      host: "other.example.org",
    });
    expect(sent).toHaveLength(0);
    expect(logged).toContainEqual({
      event: "egress.denied",
      host: "other.example.org",
      reason: "host_not_granted",
      runId: "run_1",
    });
    expect(JSON.stringify(logged)).not.toContain(SECRET_VALUE);
  });

  test("another agent with no grant for the same host gets 403, since grants are per agent", async () => {
    await grantedAgent(agentId);
    addRun("run_other", otherAgentId);

    const response = await relay(await tokenFor("run_other", otherAgentId));

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe("forwarding", () => {
  test("a granted host gets the method, path, query and body, the rule's header, and not the client's own Authorization", async () => {
    await grantedAgent();
    addRun("run_1", agentId);
    upstream = answerWith(201, '{"created":true}');

    const response = await app.request(
      `https://hm.example/api/egress/${HOST}/v1/files/a%2Fb?limit=5&q=x`,
      {
        body: '{"name":"n"}',
        headers: {
          Authorization: `Bearer ${await tokenFor("run_1")}`,
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.9",
          "X-Trace": "keep-me",
        },
        method: "POST",
      },
      env
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ created: true });
    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`https://${HOST}/v1/files/a%2Fb?limit=5&q=x`);
    expect(call?.body).toBe('{"name":"n"}');
    expect(call?.headers.get("authorization")).toBe(`Bearer ${SECRET_VALUE}`);
    expect(call?.headers.get("x-trace")).toBe("keep-me");
    expect(call?.headers.get("x-forwarded-for")).toBeNull();
    expect(JSON.stringify(sent)).not.toContain(CLIENT_TOKEN_HEADER);
  });

  test("the event names the secret and the host and never holds the value", async () => {
    await grantedAgent();
    addRun("run_1", agentId);

    await relay(await tokenFor("run_1"));

    const rows = await eventsOf("run_1");
    expect(rows.map((row) => row.type)).toEqual(["secret.injected"]);
    const payload = JSON.parse(rows[0]?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      host: HOST,
      names: [SECRET_NAME],
      via: "relay",
    });
    expect(JSON.stringify(rows)).not.toContain(SECRET_VALUE);
  });

  test("a wildcard rule serves a subdomain and refuses the bare domain", async () => {
    const created = await composed.services.secrets.create(dom, {
      mode: "proxy",
      name: "WILD_KEY",
      rules: [
        { header: "X-Api-Key", host: "*.example.com", template: "{value}" },
      ],
      value: SECRET_VALUE,
    });
    await composed.services.secrets.setGrants(dom, agentId, [created.id]);
    addRun("run_1", agentId);
    const token = await tokenFor("run_1");

    const subdomain = await relay(token, { host: "api.example.com" });
    const bare = await relay(token, { host: "example.com" });

    expect(subdomain.status).toBe(200);
    expect(sent.map((call) => call.url)).toEqual([
      "https://api.example.com/v1/items",
    ]);
    expect(sent[0]?.headers.get("x-api-key")).toBe(SECRET_VALUE);
    expect(bare.status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  test("a host segment that parses to another host is refused, and nothing is sent", async () => {
    const created = await composed.services.secrets.create(dom, {
      mode: "proxy",
      name: "WILD_KEY",
      rules: [
        { header: "X-Api-Key", host: "*.example.com", template: "{value}" },
      ],
      value: SECRET_VALUE,
    });
    await composed.services.secrets.setGrants(dom, agentId, [created.id]);
    addRun("run_1", agentId);
    const token = await tokenFor("run_1");

    // The matcher reads the segment as a subdomain of example.com, the URL parser as userinfo before evil.example.com.
    const response = await relay(token, { host: "x@evil.example.com" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "host_not_allowed" });
    expect(sent).toHaveLength(0);
  });

  test("a granted address the SSRF guard refuses gets 403 host_not_allowed and no upstream call", async () => {
    const created = await composed.services.secrets.create(dom, {
      mode: "proxy",
      name: "PRIVATE_KEY",
      rules: [{ header: "X-Api-Key", host: "10.0.0.5", template: "{value}" }],
      value: SECRET_VALUE,
    });
    await composed.services.secrets.setGrants(dom, agentId, [created.id]);
    addRun("run_1", agentId);

    const response = await relay(await tokenFor("run_1"), { host: "10.0.0.5" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "host_not_allowed" });
    expect(sent).toHaveLength(0);
    expect(logged).toContainEqual({
      event: "egress.denied",
      host: "10.0.0.5",
      reason: "host_not_allowed",
      runId: "run_1",
    });
  });

  test("an upstream answer that echoes the value comes back with [secret:NAME] in its place", async () => {
    await grantedAgent();
    addRun("run_1", agentId);
    upstream = answerWith(
      200,
      JSON.stringify({ echoed: `Bearer ${SECRET_VALUE}` })
    );

    const response = await relay(await tokenFor("run_1"));

    expect(await response.text()).toBe(
      `{"echoed":"Bearer [secret:${SECRET_NAME}]"}`
    );
  });

  test("a 302 is relayed with its location and never followed", async () => {
    await grantedAgent();
    addRun("run_1", agentId);
    upstream = () =>
      Promise.resolve(
        Response.redirect("https://elsewhere.example.org/next", 302)
      );

    const response = await relay(await tokenFor("run_1"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://elsewhere.example.org/next"
    );
    expect(sent).toHaveLength(1);
  });

  test("a managed session token works for a granted host", async () => {
    await grantedAgent();
    db.insert(sessions)
      .values({
        actorId: DOM,
        actorKind: "user",
        agentId,
        createdAt: new Date(nowMs).toISOString(),
        externalKey: "session_run_m",
        id: "session_run_m",
        origin: "mcp",
        workspaceId: WORKSPACE,
      })
      .run();
    db.insert(runs)
      .values({
        actorId: DOM,
        actorKind: "user",
        agentId,
        createdAt: new Date(nowMs).toISOString(),
        claimedBy: "managed",
        id: "run_m",
        inputText: "work",
        leaseUntil: new Date(nowMs + 30 * MINUTE_MS).toISOString(),
        onBehalfOfUserId: DOM,
        sessionId: "session_run_m",
        status: "running",
        workspaceId: WORKSPACE,
      })
      .run();
    db.insert(managedSessions)
      .values({
        agentFingerprint: "fp",
        anthropicSessionId: "sesn_1",
        createdAt: new Date(nowMs).toISOString(),
        currentRunId: "run_m",
        sessionId: "session_run_m",
        tokenIssuedAt: nowMs,
        vaultId: "vlt_1",
        workspaceId: WORKSPACE,
      })
      .run();
    const token = await signSessionToken(
      await importRunTokenKey(RUN_TOKEN_KEY),
      {
        agentId,
        issuedAt: nowMs,
        sessionId: "session_run_m",
        workspaceId: WORKSPACE,
      }
    );

    const response = await relay(token);

    expect(response.status).toBe(200);
    expect(sent[0]?.headers.get("authorization")).toBe(
      `Bearer ${SECRET_VALUE}`
    );
    expect((await eventsOf("run_m")).map((row) => row.type)).toEqual([
      "secret.injected",
    ]);
  });

  test("an unsupported method gets 405 with an Allow header and no upstream call", async () => {
    await grantedAgent();
    addRun("run_1", agentId);

    const response = await relay(await tokenFor("run_1"), {
      method: "OPTIONS",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(
      "GET, HEAD, POST, PUT, PATCH, DELETE"
    );
    expect(sent).toHaveLength(0);
  });

  test("a body over the cap gets 413 and no upstream call", async () => {
    await grantedAgent();
    addRun("run_1", agentId);

    const response = await relay(await tokenFor("run_1"), {
      body: "x".repeat(MAX_EGRESS_BODY_BYTES + 1),
      method: "POST",
    });

    expect(response.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  test("an upstream that never answers within the cap gets 504 and the event still records", async () => {
    await grantedAgent();
    addRun("run_1", agentId);
    mount(50);
    upstream = (init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });

    const response = await relay(await tokenFor("run_1"));

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "upstream_timeout" });
    expect((await eventsOf("run_1")).map((row) => row.type)).toEqual([
      "secret.injected",
    ]);
  });

  test("an upstream that cannot be reached gets 502", async () => {
    await grantedAgent();
    addRun("run_1", agentId);
    upstream = () => Promise.reject(new TypeError("connection refused"));

    const response = await relay(await tokenFor("run_1"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream_unreachable" });
  });
});
