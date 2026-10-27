import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  agentConnectors,
  connectors,
  credentials,
} from "@repo/db/schema/connectors";
import { events } from "@repo/db/schema/events";
import { machines } from "@repo/db/schema/machines";
import { managedSessions } from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import type { Fetcher } from "@repo/services/connectors/mcp";
import {
  seedAssignment,
  seedConnector,
  seedCredential,
  testOAuthConfig,
} from "@repo/services/connectors/test-seed";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { createRequestsService } from "@repo/services/requests";
import {
  importRunTokenKey,
  signRunToken,
  signSessionToken,
} from "@repo/services/run-tokens";
import type { Clock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  type StubMcp,
  startStubMcp,
} from "../../../../../scripts/dev/stub-mcp.ts";
import { type Composed, composeWith } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { PROXY_CAP_MS, type ProxyRouteOptions, proxyRoutes } from "./proxy.ts";

const WORKSPACE = "w1";
const START_MS = Date.parse("2026-10-16T10:00:00.000Z");
const MINUTE_MS = 60_000;
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const env = { RUN_TOKEN_KEY } as unknown as Env;
const PUBLIC_ORIGIN = "https://mcp.stub-test.com";
const STUB_TOKEN = "stub-token";
const CONNECTOR = "con_stub";
const PROXY_URL = `https://hm.example/api/proxy/${CONNECTOR}`;
const DOM = "user_dom";

const dom: Principal = {
  kind: "user",
  userId: DOM,
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let composed: Composed;
let stub: StubMcp | undefined;
let nowMs: number;
let agentId: string;
let secretsKey: CryptoKey;
let app: Hono<AppEnv>;
/** Called with each token endpoint request, before it goes on. */
let onTokenRequest: (() => Promise<void> | void) | undefined;

const clock: Clock = {
  now: () => new Date(nowMs),
  // Real, short waits: the loser of a refresh polls while the winner does I/O.
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.min(ms, 5));
    }),
};

const stubOf = (): StubMcp => {
  if (!stub) {
    throw new Error("start the stub first");
  }
  return stub;
};

/** Carries calls for the public-looking host to the stub. */
const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
};

const toStub: Fetcher = async (input, init) => {
  const raw = urlOf(input);
  if (raw.endsWith("/token")) {
    await onTokenRequest?.();
  }
  return await fetch(
    raw.replace(PUBLIC_ORIGIN, new URL(stubOf().url).origin),
    init
  );
};

/** A connector that never answers. Its call ends only when the signal does. */
const neverAnswers: Fetcher = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The limit ended the call.", "TimeoutError"));
    });
  });

const startStub = (options: Parameters<typeof startStubMcp>[0] = {}) => {
  stub = startStubMcp({ token: STUB_TOKEN, ...options });
};

const addRun = (
  id: string,
  status: "done" | "interrupted" | "running" = "running",
  claimedBy: string | null = null
) => {
  const now = new Date(nowMs).toISOString();
  db.insert(sessions)
    .values({
      actorId: DOM,
      actorKind: "user",
      agentId,
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
      agentId,
      createdAt: now,
      claimedBy,
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

const tokenFor = async (runId: string) =>
  signRunToken(await importRunTokenKey(RUN_TOKEN_KEY), {
    agentId,
    issuedAt: nowMs,
    runId,
    workspaceId: WORKSPACE,
  });

const echoBody = JSON.stringify({
  id: 7,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: { text: "hello" }, name: "echo" },
});

const searchBody = JSON.stringify({
  id: 8,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: { query: "hello" }, name: "search" },
});

const call = (token: string | null, body = echoBody, connector = CONNECTOR) =>
  app.request(
    `https://hm.example/api/proxy/${connector}`,
    {
      body,
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      method: "POST",
    },
    env
  );

interface Rpc {
  error?: { data?: { code?: string }; message: string };
  result?: { content: { text: string }[] };
}

/** The echoed text of a successful call, or null for any error. */
const echoed = async (response: Response): Promise<string | null> => {
  const rpc = (await response.json()) as Rpc;
  if (response.status !== 200 || rpc.error || !rpc.result) {
    return null;
  }
  return rpc.result.content.at(0)?.text ?? null;
};

const eventsOf = async (runId: string) =>
  (await db.select().from(events).where(eq(events.runId, runId))).filter(
    (row) => row.type.startsWith("connector.")
  );

const credentialRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, id));
  if (!row) {
    throw new Error("no credential row");
  }
  return row;
};

/** Sets columns on a seeded connector, such as its name or call timeout. */
const editConnector = (
  id: string,
  values: Partial<typeof connectors.$inferInsert>
) => {
  db.update(connectors).set(values).where(eq(connectors.id, id)).run();
};

/** A stub-token header credential for the agent on `connectorId`, which may use `allowedTools` (null: every tool). */
const seedHeaderCredential = async (
  connectorId = CONNECTOR,
  allowedTools: string[] | null = null
) => {
  await seedConnector(db, {
    authKind: "header",
    id: connectorId,
    now: new Date(nowMs).toISOString(),
    url: `${PUBLIC_ORIGIN}/mcp`,
    workspaceId: WORKSPACE,
  });
  await seedAssignment(db, {
    agentId,
    allowedTools,
    connectorId,
    credentialMode: "agent",
    now: new Date(nowMs).toISOString(),
    workspaceId: WORKSPACE,
  });
  return await seedCredential(db, secretsKey, {
    connectorId,
    now: new Date(nowMs).toISOString(),
    ownerId: agentId,
    ownerKind: "agent",
    secret: `Bearer ${STUB_TOKEN}`,
    workspaceId: WORKSPACE,
  });
};

/** An OAuth connector whose token endpoint is the stub's `/token`. */
const seedOAuthCredential = async (
  secret = {
    accessToken: STUB_TOKEN,
    refreshToken: "stub-refresh" as string | null,
  }
) => {
  const now = new Date(nowMs).toISOString();
  await seedConnector(db, {
    authKind: "oauth",
    id: CONNECTOR,
    now,
    oauth: testOAuthConfig(PUBLIC_ORIGIN),
    url: `${PUBLIC_ORIGIN}/mcp`,
    workspaceId: WORKSPACE,
  });
  await seedAssignment(db, {
    agentId,
    connectorId: CONNECTOR,
    credentialMode: "agent",
    now,
    workspaceId: WORKSPACE,
  });
  return await seedCredential(db, secretsKey, {
    connectorId: CONNECTOR,
    expiresAt: new Date(nowMs + 60 * MINUTE_MS).toISOString(),
    now,
    ownerId: agentId,
    ownerKind: "agent",
    secret: JSON.stringify(secret),
    workspaceId: WORKSPACE,
  });
};

/** The proxy on an app that supplies `composed` the way server.ts does. */
const mount = (options: Pick<ProxyRouteOptions, "fetch" | "timeout"> = {}) => {
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    "/api/proxy",
    proxyRoutes({ fetch: toStub, log: () => undefined, ...options })
  );
};

beforeEach(async () => {
  db = migrated();
  nowMs = START_MS;
  onTokenRequest = undefined;
  secretsKey = await importSecretsKey(SECRETS_KEY);
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
      fetch: toStub,
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
  mount();
});

afterEach(() => {
  stub?.stop();
  stub = undefined;
});

describe("the gate", () => {
  test("the cap is five minutes", () => {
    expect(PROXY_CAP_MS).toBe(5 * MINUTE_MS);
  });

  test("a missing, forged or unknown token gets 401", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1");

    expect((await call(null)).status).toBe(401);
    expect((await call("hm_run_forged.sig")).status).toBe(401);
    expect((await call("not-a-token")).status).toBe(401);
    expect(stubOf().stats().calls).toHaveLength(0);
  });

  test("a run token for a finished or interrupted run gets 401", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_done", "done");
    addRun("run_interrupted", "interrupted");

    expect((await call(await tokenFor("run_done"))).status).toBe(401);
    expect((await call(await tokenFor("run_interrupted"))).status).toBe(401);
    expect(stubOf().stats().calls).toHaveLength(0);
  });

  test("a run whose lease has passed gets 401", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1");
    const token = await tokenFor("run_1");

    nowMs += 31 * MINUTE_MS;

    expect((await call(token)).status).toBe(401);
  });

  test("a connector not assigned to the run's agent gets 403 before any credential is read", async () => {
    startStub();
    await seedConnector(db, {
      authKind: "header",
      id: CONNECTOR,
      now: new Date(nowMs).toISOString(),
      url: `${PUBLIC_ORIGIN}/mcp`,
      workspaceId: WORKSPACE,
    });
    // A credential exists, so a lookup that ran first would have found it.
    await seedCredential(db, secretsKey, {
      connectorId: CONNECTOR,
      now: new Date(nowMs).toISOString(),
      ownerId: agentId,
      ownerKind: "agent",
      secret: `Bearer ${STUB_TOKEN}`,
      workspaceId: WORKSPACE,
    });
    addRun("run_1");

    const response = await call(await tokenFor("run_1"));

    expect(response.status).toBe(403);
    expect(stubOf().stats().calls).toHaveLength(0);
    expect(await eventsOf("run_1")).toHaveLength(0);
  });

  test("a connector id that does not exist gets 403 too", async () => {
    startStub();
    addRun("run_1");

    expect((await call(await tokenFor("run_1"), echoBody, "nope")).status).toBe(
      403
    );
  });

  test("a GET is refused with 405: there is no server stream through the proxy", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1");

    const response = await app.request(
      PROXY_URL,
      { headers: { Authorization: `Bearer ${await tokenFor("run_1")}` } },
      env
    );

    expect(response.status).toBe(405);
  });
});

describe("a managed session's token", () => {
  const sessionTokenFor = async (runId: string, issuedAt = nowMs) =>
    signSessionToken(await importRunTokenKey(RUN_TOKEN_KEY), {
      agentId,
      issuedAt,
      sessionId: `session_${runId}`,
      workspaceId: WORKSPACE,
    });

  const openManagedSession = (runId: string, issuedAt = nowMs) =>
    db
      .insert(managedSessions)
      .values({
        agentFingerprint: "fp",
        anthropicSessionId: "sesn_1",
        createdAt: new Date(nowMs).toISOString(),
        currentRunId: runId,
        sessionId: `session_${runId}`,
        tokenIssuedAt: issuedAt,
        vaultId: "vlt_1",
        workspaceId: WORKSPACE,
      })
      .run();

  test("reaches the connector as the session's running run, and logs the call under it", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1", "running", "managed");
    openManagedSession("run_1");

    const response = await call(await sessionTokenFor("run_1"));

    expect(await echoed(response)).toBe("hello");
    const logged = await eventsOf("run_1");
    expect(logged.map((row) => row.type)).toEqual(["connector.call"]);
  });

  test("is refused once the session is closed, replaced or without a running run", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1", "running", "managed");
    openManagedSession("run_1");
    const token = await sessionTokenFor("run_1");

    expect((await call(await sessionTokenFor("run_1", nowMs - 1))).status).toBe(
      401
    );

    db.update(runs).set({ status: "done" }).where(eq(runs.id, "run_1")).run();
    expect((await call(token)).status).toBe(401);

    db.update(runs)
      .set({ status: "running" })
      .where(eq(runs.id, "run_1"))
      .run();
    expect((await call(token)).status).toBe(200);

    db.update(managedSessions)
      .set({ closedAt: new Date(nowMs).toISOString() })
      .run();
    expect((await call(token)).status).toBe(401);
    expect(stubOf().stats().calls).toHaveLength(1);
  });
});

describe("forwarding", () => {
  test("the stub sees the real header and never the run token, and one connector.call is logged without arguments", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1");
    const token = await tokenFor("run_1");

    expect(await echoed(await call(token))).toBe("hello");

    const seen = stubOf().stats().calls.at(0);
    expect(seen?.headers.authorization).toBe(`Bearer ${STUB_TOKEN}`);
    expect(JSON.stringify(stubOf().stats().calls)).not.toContain(token);
    const logged = await eventsOf("run_1");
    expect(logged.map((row) => row.type)).toEqual(["connector.call"]);
    const payload = JSON.parse(logged[0]?.payload ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      connectorId: CONNECTOR,
      method: "tools/call",
      outcome: "ok",
      ownerKind: "agent",
      tool: "echo",
    });
    expect(JSON.stringify(payload)).not.toContain("hello");
    expect(logged[0]?.sessionId).toBe("session_run_1");
    expect(logged[0]?.agentId).toBe(agentId);
  });

  test("a connector that echoes the login back does not hand it to the model", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1");

    const response = await call(
      await tokenFor("run_1"),
      JSON.stringify({
        id: 9,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { text: `key is ${STUB_TOKEN}` }, name: "echo" },
      })
    );

    expect(await echoed(response)).toBe("key is [redacted]");
  });

  test("a run on a single_user machine for someone who did not enrol it uses the agent's login, and the event says so", async () => {
    startStub();
    await seedHeaderCredential();
    await db.update(agentConnectors).set({ credentialMode: "user_or_agent" });
    db.insert(machines)
      .values({
        capabilities: "{}",
        createdAt: new Date(nowMs).toISOString(),
        credentialHash: "m_single",
        enrolledBy: "someone_else",
        id: "m_single",
        lastSeenAt: null,
        name: "m_single",
        singleUser: true,
        status: "online",
        workspaceId: WORKSPACE,
      })
      .run();
    addRun("run_1", "running", "m_single");

    expect(await echoed(await call(await tokenFor("run_1")))).toBe("hello");

    const [logged] = await eventsOf("run_1");
    expect(JSON.parse(logged?.payload ?? "{}")).toMatchObject({
      note: "single_user_machine",
      ownerKind: "agent",
    });
  });

  test("a login the connector refuses outright becomes needs_auth", async () => {
    // The pasted value is not the one this server wants.
    startStub({ token: "another-token" });
    const id = await seedHeaderCredential();
    addRun("run_1");

    const rpc = (await (await call(await tokenFor("run_1"))).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("needs_auth");
    expect((await credentialRow(id)).status).toBe("needs_auth");
    expect((await eventsOf("run_1")).map((row) => row.type)).toEqual([
      "connector.needs_auth",
    ]);
  });

  test("every request that gets through logs exactly one event", async () => {
    startStub();
    await seedHeaderCredential();
    addRun("run_1");
    const token = await tokenFor("run_1");

    await call(
      token,
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {},
      })
    );
    await call(
      token,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    await call(token);

    const logged = await eventsOf("run_1");
    expect(logged).toHaveLength(3);
    expect(logged.every((row) => row.type === "connector.call")).toBe(true);
  });

  test("a revoked credential gets the needs_auth error with the Connect path, and nothing is forwarded", async () => {
    startStub();
    const id = await seedHeaderCredential();
    await db
      .update(credentials)
      .set({ status: "revoked" })
      .where(eq(credentials.id, id));
    addRun("run_1");

    const response = await call(await tokenFor("run_1"));

    expect(response.status).toBe(200);
    const rpc = (await response.json()) as Rpc;
    expect(rpc.error?.data?.code).toBe("needs_auth");
    expect(rpc.error?.message).toContain(
      `/connect/${CONNECTOR}?as=agent:${agentId}`
    );
    expect(stubOf().stats().calls).toHaveLength(0);
    const logged = await eventsOf("run_1");
    expect(logged.map((row) => row.type)).toEqual(["connector.needs_auth"]);
  });

  test("a run for a person without a credential is told to connect as that person", async () => {
    startStub();
    await seedHeaderCredential();
    await db.update(agentConnectors).set({ credentialMode: "user" });
    addRun("run_1");

    const rpc = (await (await call(await tokenFor("run_1"))).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("needs_auth");
    expect(rpc.error?.message).toContain(`/connect/${CONNECTOR}?as=user`);
  });
});

describe("refreshing", () => {
  test("--fail-once makes the next call refresh and succeed with version = 2", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential();
    addRun("run_1");

    expect(await echoed(await call(await tokenFor("run_1")))).toBe("hello");

    expect(stubOf().stats().tokenCalls).toBe(1);
    const row = await credentialRow(id);
    expect(row.version).toBe(2);
    expect(row.status).toBe("ok");
    expect(row.refreshingUntil).toBeNull();
    const headers = stubOf()
      .stats()
      .calls.map((c) => c.headers.authorization);
    // The stub does not record the call it refuses.
    expect(headers).toEqual([`Bearer ${STUB_TOKEN}-refreshed-1`]);
    // The next call uses the stored token and needs no refresh.
    expect(await echoed(await call(await tokenFor("run_1")))).toBe("hello");
    expect(stubOf().stats().tokenCalls).toBe(1);
  });

  test("two concurrent calls that both see a 401 make exactly one token-endpoint call and both succeed", async () => {
    startStub({ failOnce: true });
    await seedOAuthCredential();
    addRun("run_1");
    const token = await tokenFor("run_1");

    const [first, second] = await Promise.all([call(token), call(token)]);

    expect(await echoed(first)).toBe("hello");
    expect(await echoed(second)).toBe("hello");
    expect(stubOf().stats().tokenCalls).toBe(1);
  });

  test("a refresh racing a revocation leaves the row revoked and the stale write is rejected", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential();
    addRun("run_1");
    const before = await credentialRow(id);
    let release: () => void = () => undefined;
    let inFlight: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      inFlight = resolve;
    });
    onTokenRequest = async () => {
      inFlight();
      await held;
    };

    const pending = call(await tokenFor("run_1"));
    await started;
    // The person revokes while the token endpoint is being called.
    await db
      .update(credentials)
      .set({ refreshingUntil: null, status: "revoked", version: 2 })
      .where(eq(credentials.id, id));
    release();
    const rpc = (await (await pending).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("needs_auth");
    const after = await credentialRow(id);
    expect(after.status).toBe("revoked");
    expect(after.version).toBe(2);
    expect(after.secret).toBe(before.secret);
    expect(stubOf().stats().tokenCalls).toBe(1);
  });

  test("a refresh racing a re-authorisation leaves the newer grant", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential();
    addRun("run_1");
    let release: () => void = () => undefined;
    let inFlight: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      inFlight = resolve;
    });
    onTokenRequest = async () => {
      inFlight();
      await held;
    };

    const pending = call(await tokenFor("run_1"));
    await started;
    // The person connects again while the token endpoint is being called. The
    // grant is one the stub accepts after its own refresh.
    const regranted = await encryptSecret(
      secretsKey,
      {
        field: "secret",
        rowId: id,
        table: "credentials",
        workspaceId: WORKSPACE,
      },
      JSON.stringify({
        accessToken: `${STUB_TOKEN}-refreshed-1`,
        refreshToken: "regranted-refresh",
      })
    );
    await db
      .update(credentials)
      .set({
        refreshingUntil: null,
        secret: regranted,
        status: "ok",
        version: 2,
      })
      .where(eq(credentials.id, id));
    release();

    expect(await echoed(await pending)).toBe("hello");
    const after = await credentialRow(id);
    expect(after.version).toBe(2);
    expect(after.secret).toBe(regranted);
  });

  test("a lease holder that dies leaves a lease that expires in 30 s, and the next caller takes it", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential();
    addRun("run_1");
    const token = await tokenFor("run_1");
    // The first caller takes the lease and never comes back.
    onTokenRequest = () => new Promise<void>(() => undefined);
    Promise.resolve(call(token)).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const leased = await credentialRow(id);
    expect(Date.parse(leased.refreshingUntil ?? "")).toBe(nowMs + 30_000);

    // Inside the lease the caller waits, finds nothing new, and is told to retry.
    onTokenRequest = undefined;
    const waiting = (await (await call(token)).json()) as Rpc;
    expect(waiting.error?.data?.code).toBe("retry");
    expect(stubOf().stats().tokenCalls).toBe(0);

    nowMs += 31_000;

    expect(await echoed(await call(token))).toBe("hello");
    expect(stubOf().stats().tokenCalls).toBe(1);
    expect((await credentialRow(id)).version).toBe(2);
  });

  test("--fail-once with no refresh token sets needs_auth and appends connector.needs_auth", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential({
      accessToken: STUB_TOKEN,
      refreshToken: null,
    });
    addRun("run_1");

    const rpc = (await (await call(await tokenFor("run_1"))).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("needs_auth");
    expect(rpc.error?.message).toContain(
      `/connect/${CONNECTOR}?as=agent:${agentId}`
    );
    const row = await credentialRow(id);
    expect(row.status).toBe("needs_auth");
    expect(row.refreshingUntil).toBeNull();
    expect(stubOf().stats().tokenCalls).toBe(0);
    expect((await eventsOf("run_1")).map((e) => e.type)).toEqual([
      "connector.needs_auth",
    ]);
    // The next call does not even reach the server.
    const calls = stubOf().stats().calls.length;
    await call(await tokenFor("run_1"));
    expect(stubOf().stats().calls).toHaveLength(calls);
  });

  test("a token endpoint that refuses the refresh token sets needs_auth", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential();
    addRun("run_1");
    // A 400 from the token endpoint is the provider saying no.
    const refusing: Fetcher = (input, init) =>
      String(input).endsWith("/token")
        ? Promise.resolve(
            Response.json({ error: "invalid_grant" }, { status: 400 })
          )
        : toStub(input, init);
    composed = composeWith({
      allowedOrgIds: ["org_w1"],
      db,
      infra: {
        atomic: sqliteAtomic(db),
        blobs: {
          get: () => Promise.resolve(null),
          put: () => Promise.resolve(),
        },
        clock,
        devFakeRuntime: true,
        fetch: refusing,
        fileBlobs: memoryFileBlobs(),
        relay: noopRelay,
        runTokenKey: RUN_TOKEN_KEY,
        secretsKey: SECRETS_KEY,
      },
    });

    const rpc = (await (await call(await tokenFor("run_1"))).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("needs_auth");
    expect((await credentialRow(id)).status).toBe("needs_auth");
  });

  test("a token endpoint that is down leaves the credential alone and asks the model to retry", async () => {
    startStub({ failOnce: true });
    const id = await seedOAuthCredential();
    addRun("run_1");
    const down: Fetcher = (input, init) =>
      String(input).endsWith("/token")
        ? Promise.resolve(new Response("busy", { status: 503 }))
        : toStub(input, init);
    composed = composeWith({
      allowedOrgIds: ["org_w1"],
      db,
      infra: {
        atomic: sqliteAtomic(db),
        blobs: {
          get: () => Promise.resolve(null),
          put: () => Promise.resolve(),
        },
        clock,
        devFakeRuntime: true,
        fetch: down,
        fileBlobs: memoryFileBlobs(),
        relay: noopRelay,
        runTokenKey: RUN_TOKEN_KEY,
        secretsKey: SECRETS_KEY,
      },
    });

    const rpc = (await (await call(await tokenFor("run_1"))).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("retry");
    const row = await credentialRow(id);
    expect(row.status).toBe("ok");
    expect(row.refreshingUntil).toBeNull();
    expect(row.version).toBe(1);
  });
});

describe("the limit", () => {
  test("a call that outlasts its limit gets the timeout message and one connector.call event", async () => {
    // A connector that never answers, and a signal that ends the call after
    // 300 ms. The message names the connector's own limit, 60 s by default.
    await seedHeaderCredential();
    editConnector(CONNECTOR, { name: "the-brain" });
    addRun("run_1");
    mount({
      fetch: neverAnswers,
      timeout: () => AbortSignal.timeout(300),
    });

    const rpc = (await (
      await call(await tokenFor("run_1"), searchBody)
    ).json()) as Rpc;

    expect(rpc.error?.data?.code).toBe("timeout");
    expect(rpc.error?.message).toBe(
      "the-brain search timed out after 60 s. Try a smaller request or retry."
    );
    const logged = await eventsOf("run_1");
    expect(logged.map((row) => row.type)).toEqual(["connector.call"]);
    expect(JSON.parse(logged[0]?.payload ?? "{}")).toMatchObject({
      limitSeconds: 60,
      method: "tools/call",
      ms: expect.any(Number),
      outcome: "timeout",
      ownerKind: "agent",
      tool: "search",
    });
  });

  test("each connector's own callTimeoutSeconds sets the limit it is called with", async () => {
    startStub();
    await seedHeaderCredential();
    await seedHeaderCredential("con_long");
    editConnector("con_long", { callTimeoutSeconds: 120 });
    addRun("run_1");
    const token = await tokenFor("run_1");
    const asked: number[] = [];
    mount({
      timeout: (ms) => {
        asked.push(ms);
        return new AbortController().signal;
      },
    });

    expect(await echoed(await call(token))).toBe("hello");
    expect(await echoed(await call(token, echoBody, "con_long"))).toBe("hello");

    expect(asked).toEqual([60_000, 120_000]);
  });

  test("aborting the limit's signal reaches the upstream fetch", async () => {
    await seedHeaderCredential();
    addRun("run_1");
    const limit = new AbortController();
    let seen: AbortSignal | null | undefined;
    let failedWith: string | undefined;
    let reachUpstream: () => void = () => undefined;
    const upstreamCalled = new Promise<void>((resolve) => {
      reachUpstream = resolve;
    });
    const hanging: Fetcher = (_input, init) => {
      seen = init?.signal;
      reachUpstream();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new DOMException(
            "The limit ended the call.",
            "TimeoutError"
          );
          failedWith = error.name;
          reject(error);
        });
      });
    };
    mount({ fetch: hanging, timeout: () => limit.signal });

    const pending = call(await tokenFor("run_1"));
    await upstreamCalled;
    limit.abort();
    const rpc = (await (await pending).json()) as Rpc;

    expect(seen).toBe(limit.signal);
    expect(failedWith).toBe("TimeoutError");
    expect(rpc.error?.data?.code).toBe("timeout");
  });

  test("a call that finishes inside its limit is not stopped", async () => {
    startStub({ sleepSeconds: 0.1 });
    await seedHeaderCredential();
    addRun("run_1");
    mount({ timeout: () => AbortSignal.timeout(2000) });

    expect(await echoed(await call(await tokenFor("run_1")))).toBe("hello");
  });
});

describe("tool allowlist", () => {
  const listBody = JSON.stringify({
    id: 3,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  const shoutBody = JSON.stringify({
    id: 4,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { text: "hi" }, name: "shout" },
  });
  const batchBody = JSON.stringify([
    JSON.parse(echoBody),
    JSON.parse(searchBody),
  ]);

  const namesOf = async (response: Response): Promise<string[]> => {
    const rpc = (await response.json()) as {
      result: { tools: { name: string }[] };
    };
    return rpc.result.tools.map((tool) => tool.name);
  };

  test("tools/list lists only the allowed tools", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");

    const response = await call(await tokenFor("run_1"), listBody);

    expect(response.status).toBe(200);
    expect(await namesOf(response)).toEqual(["echo"]);
  });

  test("an allowed tools/call goes through", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");

    expect(await echoed(await call(await tokenFor("run_1")))).toBe("hello");
  });

  test("a tools/call naming a tool outside the list is refused before the connector, and the denial is logged", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");

    const response = await call(await tokenFor("run_1"), shoutBody);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "forbidden",
      reason: "tool_not_allowed",
    });
    expect(
      stubOf()
        .stats()
        .calls.filter((seen) => seen.method === "tools/call")
    ).toHaveLength(0);
    const logged = await eventsOf("run_1");
    expect(logged.map((row) => row.type)).toEqual(["connector.call"]);
    expect(JSON.parse(logged[0]?.payload ?? "{}")).toMatchObject({
      note: "tool_not_allowed",
      outcome: "denied",
      tool: "shout",
    });
  });

  test("a JSON-RPC batch is refused whole when the allowlist is set", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");

    const response = await call(await tokenFor("run_1"), batchBody);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "forbidden",
      reason: "tool_not_allowed",
    });
    expect(stubOf().stats().calls).toHaveLength(0);
  });

  test("a body JSON.parse cannot read as one call is refused when the allowlist is set", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");
    const token = await tokenFor("run_1");
    const nan =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shout","arguments":{"text":"hi","n":NaN}}}';

    const responses = await Promise.all(
      [nan, "not json", '{"id":1}', "[1]", '"tools/call"'].map((body) =>
        call(token, body)
      )
    );

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403,
    ]);
    expect(stubOf().stats().calls).toHaveLength(0);
  });

  test("keys a looser parser could read as protocol keys are refused when the allowlist is set", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");
    const token = await tokenFor("run_1");
    const bodies = [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","NAME":"shout"}}',
      '{"jsonrpc":"2.0","id":1,"method":"ping","METHOD":"tools/list"}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"},"paramſ":{"name":"shout"}}',
    ];

    const responses = await Promise.all(
      bodies.map((body) => call(token, body))
    );

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
    expect(stubOf().stats().calls).toHaveLength(0);
  });

  test("initialize, notifications and an empty DELETE still pass when the allowlist is set", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");
    const token = await tokenFor("run_1");
    const init = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, protocolVersion: "2025-06-18" },
    });
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect((await call(token, init)).status).toBe(200);
    expect((await call(token, note)).status).toBe(202);
    const deleted = await app.request(
      `https://hm.example/api/proxy/${CONNECTOR}`,
      { headers: { Authorization: `Bearer ${token}` }, method: "DELETE" },
      env
    );
    expect(deleted.status).not.toBe(403);
  });

  test("a body JSON.parse cannot read still goes upstream with no allowlist", async () => {
    startStub({ shout: true });
    await seedHeaderCredential();
    addRun("run_1");

    const response = await call(await tokenFor("run_1"), "not json");

    expect(response.status).not.toBe(403);
  });

  test("with no allowlist the same stub lists both tools and shout works", async () => {
    startStub({ shout: true });
    await seedHeaderCredential();
    addRun("run_1");
    const token = await tokenFor("run_1");

    expect(await namesOf(await call(token, listBody))).toEqual([
      "echo",
      "shout",
    ]);
    expect(await echoed(await call(token, shoutBody))).toBe("HI");
  });

  test("an empty list stored for the assignment is unrestricted", async () => {
    startStub({ shout: true });
    await seedHeaderCredential(CONNECTOR, []);
    addRun("run_1");
    const token = await tokenFor("run_1");

    expect(await namesOf(await call(token, listBody))).toEqual([
      "echo",
      "shout",
    ]);
    expect(await echoed(await call(token, shoutBody))).toBe("HI");
  });

  test("a tools/list answer sent as an event stream by the connector is filtered too", async () => {
    const message = {
      id: 3,
      jsonrpc: "2.0",
      result: { tools: [{ name: "echo" }, { name: "shout" }] },
    };
    const sseAnswer: Fetcher = () =>
      Promise.resolve(
        new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })
      );
    mount({ fetch: sseAnswer });
    await seedHeaderCredential(CONNECTOR, ["echo"]);
    addRun("run_1");

    const response = await call(await tokenFor("run_1"), listBody);
    const text = await response.text();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(text).toContain('"name":"echo"');
    expect(text).not.toContain("shout");
  });
});

/** Real approval persistence and current-presence port; only connector I/O is captured. */
const guestPresentProxy = async (
  options: { oauth?: boolean; present?: () => boolean } = {}
) => {
  if (options.oauth) {
    await seedOAuthCredential();
  } else {
    await seedHeaderCredential();
  }
  addRun("guest-present");
  const now = clock.now().toISOString();
  await db.insert(artifacts).values({
    id: "approval-source",
    workspaceId: WORKSPACE,
    kind: "document",
    title: "Approval source",
    audience: "private",
    ownerUserId: DOM,
    createdByKind: "user",
    createdById: DOM,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(sessions)
    .set({ origin: "artifact", externalKey: "approval-source", private: false })
    .where(eq(sessions.id, "session_guest-present"));
  composed.services.requests = createRequestsService({
    db,
    atomic: sqliteAtomic(db),
    clock,
    events: composed.services.events,
    runs: composed.services.runs,
    secrets: composed.services.secrets,
    runTokenKey: RUN_TOKEN_KEY,
    guestPresence: (scope) => {
      if (
        scope.artifactId !== "approval-source" ||
        scope.workspaceId !== WORKSPACE
      ) {
        throw new Error("Wrong trusted presence scope");
      }
      return Promise.resolve(options.present?.() ?? true);
    },
  });
  const sent: { body: string; headers: Record<string, string>; url: string }[] =
    [];
  mount({
    fetch: (input, init) => {
      sent.push({
        body: new TextDecoder().decode(init?.body as Uint8Array),
        headers: Object.fromEntries(new Headers(init?.headers)),
        url: urlOf(input),
      });
      return options.oauth
        ? toStub(input, init)
        : Promise.resolve(
            Response.json({ jsonrpc: "2.0", id: 7, result: { content: [] } })
          );
    },
  });
  const token = await tokenFor("guest-present");
  const send = (body: string, headers: Record<string, string> = {}) =>
    app.request(
      PROXY_URL,
      {
        method: "POST",
        body,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...headers,
        },
      },
      env
    );
  const approve = async () => {
    const pending = await composed.services.requests.listPending(dom);
    const [request] = pending;
    if (pending.length !== 1 || !request) {
      throw new Error("Expected one pending member approval");
    }
    await composed.services.requests.answer(dom, {
      requestId: request.id,
      answer: { decision: "allow_once" },
      via: "web",
    });
  };
  return { send, sent, approve };
};

test.each(["initialize", "notifications/initialized", "tools/list", "ping"])(
  "guest-present connector %s cannot forward arbitrary handshake body or headers without approval",
  async (method) => {
    const f = await guestPresentProxy();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method,
      params: { clientInfo: { name: "private document text", version: "1" } },
    });
    const headers = { "mcp-session-id": "private header text" };
    expect((await f.send(body, headers)).status).not.toBe(200);
    expect(f.sent).toHaveLength(0);
    await f.approve();
    expect((await f.send(body, headers)).status).toBe(200);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.body).toBe(body);
    expect(f.sent[0]?.headers["mcp-session-id"]).toBe("private header text");
  }
);

test("connector approval binds destination, all forwarded headers and complete body, and permits one concurrent send", async () => {
  const f = await guestPresentProxy();
  expect((await f.send(echoBody)).status).not.toBe(200);
  await f.approve();
  const changed = JSON.parse(echoBody);
  changed.params._meta = { privateText: "not approved" };
  expect((await f.send(JSON.stringify(changed))).status).not.toBe(200);
  for (const header of [
    "accept",
    "content-type",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
  ]) {
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: each refused request is checked before the next substitution.
      (await f.send(echoBody, { [header]: "unapproved-value" })).status
    ).not.toBe(200);
  }
  editConnector(CONNECTOR, { url: `${PUBLIC_ORIGIN}/different` });
  expect((await f.send(echoBody)).status).not.toBe(200);
  editConnector(CONNECTOR, { url: `${PUBLIC_ORIGIN}/mcp` });
  expect(f.sent).toHaveLength(0);
  const responses = await Promise.all([f.send(echoBody), f.send(echoBody)]);
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]?.body).toBe(echoBody);
  expect((await f.send(echoBody)).status).not.toBe(200);
  expect(f.sent).toHaveLength(1);
});

test("a connector 401 refresh cannot resend under a consumed guest-present approval", async () => {
  startStub({ failOnce: true });
  const f = await guestPresentProxy({ oauth: true });
  expect((await f.send(echoBody)).status).not.toBe(200);
  expect(f.sent).toHaveLength(0);
  await f.approve();
  expect((await f.send(echoBody)).status).not.toBe(200);
  expect(f.sent).toHaveLength(1);
  expect(stubOf().stats().tokenCalls).toBe(1);
  expect(stubOf().stats().calls).toHaveLength(0);
  await f.approve();
  expect(await echoed(await f.send(echoBody))).toBe("hello");
  expect(f.sent).toHaveLength(2);
  expect(stubOf().stats().calls).toHaveLength(1);
  expect((await f.send(echoBody)).status).not.toBe(200);
  expect(f.sent).toHaveLength(2);
});

test("a guest joining during real credential refresh blocks the second connector send", async () => {
  startStub({ failOnce: true });
  let present = false;
  const f = await guestPresentProxy({ oauth: true, present: () => present });
  onTokenRequest = () => {
    present = true;
  };
  expect((await f.send(echoBody)).status).not.toBe(200);
  expect(f.sent).toHaveLength(1);
  expect(stubOf().stats().tokenCalls).toBe(1);
  expect(stubOf().stats().calls).toHaveLength(0);
  await f.approve();
  expect(await echoed(await f.send(echoBody))).toBe("hello");
  expect(f.sent).toHaveLength(2);
  expect(stubOf().stats().calls).toHaveLength(1);
});
