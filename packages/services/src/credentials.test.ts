import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  agentConnectors,
  connectors,
  credentials,
} from "@repo/db/schema/connectors";
import { machines } from "@repo/db/schema/machines";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import type { CredentialMode } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import {
  seedAssignment,
  seedConnector,
  seedCredential,
  testOAuthConfig,
} from "./connectors/test-seed.ts";
import {
  type CredentialsService,
  createCredentialsService,
  type Resolution,
} from "./credentials.ts";
import { importSecretsKey } from "./crypto.ts";
import { createEventsService } from "./events.ts";
import { createMachineRuntime } from "./machines/runtime.ts";
import { noopRelay } from "./machines/types.ts";
import { validateSubagentAccess } from "./runs/access-scope.ts";
import type { Clock } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const MINUTE_MS = 60_000;
const ORIGIN = "https://mcp.stub-test.com";
const CONNECTOR = "con_1";

const dom = "user_dom";
const sam = "user_sam";

const sessionUser = (userId: string): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId: WORKSPACE,
});

let db: ReturnType<typeof migrated>;
let key: CryptoKey;
let nowMs: number;
let service: CredentialsService;
let agentId: string;
let otherAgentId: string;
let runs: RunsService;
let tokenCalls: number;

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: () => Promise.resolve(),
};

const iso = (offsetMs = 0) => new Date(nowMs + offsetMs).toISOString();

/** A token endpoint that hands out `fresh-<n>`. */
const tokenEndpoint: Fetcher = () => {
  tokenCalls += 1;
  return Promise.resolve(
    Response.json({
      access_token: `fresh-${tokenCalls}`,
      expires_in: 3600,
      refresh_token: `refresh-${tokenCalls}`,
    })
  );
};

const addMachine = (id: string, singleUser: boolean, enrolledBy: string) =>
  db
    .insert(machines)
    .values({
      capabilities: "{}",
      createdAt: START,
      credentialHash: id,
      enrolledBy,
      id,
      lastSeenAt: null,
      name: id,
      singleUser,
      status: "online",
      workspaceId: WORKSPACE,
    })
    .run();

const assign = (mode: CredentialMode, agent = agentId, connector = CONNECTOR) =>
  seedAssignment(db, {
    agentId: agent,
    connectorId: connector,
    credentialMode: mode,
    now: START,
    workspaceId: WORKSPACE,
  });

const addCredential = (
  ownerKind: "agent" | "user",
  ownerId: string,
  secret: string,
  extra: { status?: "needs_auth" | "ok" | "revoked" } = {}
) =>
  seedCredential(db, key, {
    connectorId: CONNECTOR,
    now: START,
    ownerId,
    ownerKind,
    secret,
    workspaceId: WORKSPACE,
    ...extra,
  });

const resolve = (
  onBehalfOfUserId: string | null,
  extra: { machineId?: string } = {}
) =>
  service.resolve({
    agentId,
    connectorId: CONNECTOR,
    onBehalfOfUserId,
    workspaceId: WORKSPACE,
    ...extra,
  });

const headerOf = (result: Resolution) =>
  result.ok && result.credential ? result.credential.header.value : null;

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  tokenCalls = 0;
  key = await importSecretsKey(SECRETS_KEY);
  for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
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
  addMachine("m_shared", false, dom);
  addMachine("m_single", true, dom);
  const store = new Map<string, string>();
  const blobs = {
    get: (name: string) => Promise.resolve(store.get(name) ?? null),
    put: (name: string, body: string) => {
      store.set(name, body);
      return Promise.resolve();
    },
  };
  const agents = createAgentsService({
    db,
    events: createEventsService({ blobs, db }),
  });
  agentId = (
    await agents.create(sessionUser(dom), {
      machineId: "m_shared",
      model: "m",
      name: "Bruce",
      runtime: "machine",
    })
  ).id;
  otherAgentId = (
    await agents.create(sessionUser(dom), {
      machineId: "m_shared",
      model: "m",
      name: "Casey",
      runtime: "machine",
    })
  ).id;
  runs = createRunsService({
    adapters: [createMachineRuntime({ relay: noopRelay })],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
    runTokenKey: RUN_TOKEN_KEY,
  });
  service = createCredentialsService({
    clock,
    db,
    fetch: tokenEndpoint,
    secretsKey: SECRETS_KEY,
  });
  await seedConnector(db, {
    authKind: "header",
    headerName: "X-Api-Key",
    id: CONNECTOR,
    now: START,
    workspaceId: WORKSPACE,
  });
});

describe("the mode matrix", () => {
  test("user_or_agent, a person with a credential, uses the person's, not the agent's", async () => {
    await assign("user_or_agent");
    await addCredential("user", dom, "dom-key");
    await addCredential("agent", agentId, "agent-key");

    const result = await resolve(dom);

    expect(result.ok).toBe(true);
    expect(headerOf(result)).toBe("dom-key");
    expect(result.ok && result.ownerKind).toBe("user");
    expect(result.ok && result.note).toBeNull();
  });

  test("user_or_agent, a person without one, is needs_auth with a Connect path and never the agent's", async () => {
    await assign("user_or_agent");
    await addCredential("agent", agentId, "agent-key");

    const result = await resolve(sam);

    expect(result).toEqual({
      cause: "missing",
      connectPath: `/connect/${CONNECTOR}?as=user`,
      ok: false,
      ownerId: sam,
      ownerKind: "user",
      reason: "needs_auth",
    });
  });

  test("user_or_agent, nobody, uses the agent's", async () => {
    await assign("user_or_agent");
    await addCredential("user", dom, "dom-key");
    await addCredential("agent", agentId, "agent-key");

    const result = await resolve(null);

    expect(headerOf(result)).toBe("agent-key");
    expect(result.ok && result.ownerKind).toBe("agent");
  });

  test("user_or_agent, nobody, with no agent credential asks to connect the agent", async () => {
    await assign("user_or_agent");
    await addCredential("user", dom, "dom-key");

    const result = await resolve(null);

    expect(result).toMatchObject({
      connectPath: `/connect/${CONNECTOR}?as=agent:${agentId}`,
      ok: false,
      ownerId: agentId,
      ownerKind: "agent",
      reason: "needs_auth",
    });
  });

  test("agent mode uses the agent's credential even for a person who has one", async () => {
    await assign("agent");
    await addCredential("user", dom, "dom-key");
    await addCredential("agent", agentId, "agent-key");

    expect(headerOf(await resolve(dom))).toBe("agent-key");
    expect(headerOf(await resolve(null))).toBe("agent-key");
  });

  test("agent mode without an agent credential is needs_auth for the agent", async () => {
    await assign("agent");
    await addCredential("user", dom, "dom-key");

    expect(await resolve(dom)).toMatchObject({
      ok: false,
      ownerKind: "agent",
      reason: "needs_auth",
    });
  });

  test("user mode uses only the person's credential", async () => {
    await assign("user");
    await addCredential("user", dom, "dom-key");
    await addCredential("agent", agentId, "agent-key");

    expect(headerOf(await resolve(dom))).toBe("dom-key");
    expect(await resolve(sam)).toMatchObject({
      cause: "missing",
      ok: false,
      ownerId: sam,
      ownerKind: "user",
    });
  });

  test("user mode with nobody is needs_auth and has nobody to connect", async () => {
    await assign("user");
    await addCredential("agent", agentId, "agent-key");

    expect(await resolve(null)).toMatchObject({
      cause: "no_person",
      connectPath: null,
      ok: false,
      reason: "needs_auth",
    });
  });
});

describe("what counts as a credential", () => {
  test("revoked and refused credentials are needs_auth", async () => {
    await assign("agent");
    const revoked = await addCredential("agent", agentId, "k", {
      status: "revoked",
    });

    expect(await resolve(null)).toMatchObject({
      cause: "revoked",
      ok: false,
      reason: "needs_auth",
    });

    await db
      .update(credentials)
      .set({ status: "needs_auth" })
      .where(eq(credentials.id, revoked));
    expect(await resolve(null)).toMatchObject({
      cause: "needs_auth",
      ok: false,
    });
  });

  test("a connector the agent is not assigned is not_assigned, before any credential is read", async () => {
    await addCredential("agent", agentId, "k");
    await assign("agent", otherAgentId);

    expect(await resolve(null)).toEqual({ ok: false, reason: "not_assigned" });
  });

  test("a connector of another workspace is not_assigned", async () => {
    await assign("agent");

    expect(
      await service.resolve({
        agentId,
        connectorId: CONNECTOR,
        onBehalfOfUserId: null,
        workspaceId: OTHER_WORKSPACE,
      })
    ).toEqual({ ok: false, reason: "not_assigned" });
  });

  test("a connector that takes no login resolves without a credential", async () => {
    await seedConnector(db, {
      authKind: "none",
      id: "con_open",
      now: START,
      workspaceId: WORKSPACE,
    });
    await assign("user", agentId, "con_open");

    const result = await service.resolve({
      agentId,
      connectorId: "con_open",
      onBehalfOfUserId: null,
      workspaceId: WORKSPACE,
    });

    expect(result).toMatchObject({ credential: null, ok: true });
  });

  test("a header credential goes out under the connector's header name, an OAuth one as a bearer token", async () => {
    await assign("agent");
    await addCredential("agent", agentId, "plain-value");
    const header = await resolve(null);
    expect(header.ok && header.credential?.header).toEqual({
      name: "X-Api-Key",
      value: "plain-value",
    });

    await seedConnector(db, {
      authKind: "oauth",
      id: "con_oauth",
      now: START,
      oauth: testOAuthConfig(ORIGIN),
      workspaceId: WORKSPACE,
    });
    await assign("agent", agentId, "con_oauth");
    await seedCredential(db, key, {
      connectorId: "con_oauth",
      expiresAt: iso(60 * MINUTE_MS),
      now: START,
      ownerId: agentId,
      ownerKind: "agent",
      secret: JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1" }),
      workspaceId: WORKSPACE,
    });
    const oauth = await service.resolve({
      agentId,
      connectorId: "con_oauth",
      onBehalfOfUserId: null,
      workspaceId: WORKSPACE,
    });
    expect(oauth.ok && oauth.credential?.header).toEqual({
      name: "Authorization",
      value: "Bearer at-1",
    });
    expect(tokenCalls).toBe(0);
  });
});

describe("the call timeout", () => {
  test("a credential resolution carries the default 60 s, then the stored value once it is changed", async () => {
    await assign("agent");
    await addCredential("agent", agentId, "agent-key");

    const before = await resolve(null);
    expect(before.ok && before.connector.callTimeoutSeconds).toBe(60);

    db.update(connectors)
      .set({ callTimeoutSeconds: 120 })
      .where(eq(connectors.id, CONNECTOR))
      .run();

    const after = await resolve(null);
    expect(after.ok && after.connector.callTimeoutSeconds).toBe(120);
    expect(headerOf(after)).toBe("agent-key");
  });

  test("a connector that takes no login carries the default 60 s, then the stored value once it is changed", async () => {
    await seedConnector(db, {
      authKind: "none",
      id: "con_open",
      now: START,
      workspaceId: WORKSPACE,
    });
    await assign("user", agentId, "con_open");
    const open = () =>
      service.resolve({
        agentId,
        connectorId: "con_open",
        onBehalfOfUserId: null,
        workspaceId: WORKSPACE,
      });

    expect(await open()).toMatchObject({
      connector: { callTimeoutSeconds: 60, id: "con_open" },
      ok: true,
    });

    db.update(connectors)
      .set({ callTimeoutSeconds: 120 })
      .where(eq(connectors.id, "con_open"))
      .run();

    expect(await open()).toMatchObject({
      connector: { callTimeoutSeconds: 120 },
      ok: true,
    });
  });
});

describe("the chain", () => {
  test("a user without a credential starts run A, A's token starts run B on another agent, and B resolves needs_auth", async () => {
    await assign("user_or_agent", agentId);
    await assign("user_or_agent", otherAgentId);
    // The other agent has a credential of its own. It must not be used.
    await seedCredential(db, key, {
      connectorId: CONNECTOR,
      now: START,
      ownerId: otherAgentId,
      ownerKind: "agent",
      secret: "agent-key",
      workspaceId: WORKSPACE,
    });

    const a = await runs.startRun(sessionUser(sam), {
      agentId,
      input: { text: "ask Casey" },
      session: { origin: "ui" },
    });
    const b = await runs.startRun(
      { agentId, kind: "run", runId: a.runId, workspaceId: WORKSPACE },
      {
        agentId: otherAgentId,
        input: { text: "hi" },
        session: { origin: "mcp" },
      }
    );
    const [rowB] = await db
      .select({ onBehalfOfUserId: runRows.onBehalfOfUserId })
      .from(runRows)
      .where(eq(runRows.id, b.runId));

    expect(rowB?.onBehalfOfUserId).toBe(sam);
    const result = await service.resolve({
      agentId: otherAgentId,
      connectorId: CONNECTOR,
      onBehalfOfUserId: rowB?.onBehalfOfUserId ?? null,
      workspaceId: WORKSPACE,
    });
    expect(result).toMatchObject({
      cause: "missing",
      connectPath: `/connect/${CONNECTOR}?as=user`,
      ok: false,
      ownerId: sam,
      ownerKind: "user",
    });
  });
});

describe("a single_user machine", () => {
  beforeEach(async () => {
    await assign("user_or_agent");
    await addCredential("user", sam, "sam-key");
    await addCredential("user", dom, "dom-key");
    await addCredential("agent", agentId, "agent-key");
  });

  test("a run for someone who did not enrol it resolves the agent credential and says why", async () => {
    const result = await resolve(sam, { machineId: "m_single" });

    expect(headerOf(result)).toBe("agent-key");
    expect(result).toMatchObject({
      note: "single_user_machine",
      ok: true,
      ownerKind: "agent",
    });
  });

  test("a run for the person who enrolled it still uses their own", async () => {
    const result = await resolve(dom, { machineId: "m_single" });

    expect(headerOf(result)).toBe("dom-key");
    expect(result.ok && result.note).toBeNull();
  });

  test("a machine with a separate agent user does not change the rule", async () => {
    const result = await resolve(sam, { machineId: "m_shared" });

    expect(headerOf(result)).toBe("sam-key");
  });

  test("user mode there is needs_auth, not the agent's credential", async () => {
    await db.update(agentConnectors).set({ credentialMode: "user" });

    expect(await resolve(sam, { machineId: "m_single" })).toMatchObject({
      cause: "single_user_machine",
      connectPath: null,
      ok: false,
      reason: "needs_auth",
    });
  });
});

describe("refresh ahead", () => {
  const OAUTH = "con_oauth";
  const oauthSecret = JSON.stringify({
    accessToken: "old-access",
    refreshToken: "old-refresh",
  });

  beforeEach(async () => {
    await seedConnector(db, {
      authKind: "oauth",
      id: OAUTH,
      now: START,
      oauth: testOAuthConfig(ORIGIN),
      workspaceId: WORKSPACE,
    });
    await assign("agent", agentId, OAUTH);
  });

  const resolveOauth = () =>
    service.resolve({
      agentId,
      connectorId: OAUTH,
      onBehalfOfUserId: null,
      workspaceId: WORKSPACE,
    });

  test("a token with more than two minutes left is used as it is", async () => {
    await seedCredential(db, key, {
      connectorId: OAUTH,
      expiresAt: iso(10 * MINUTE_MS),
      now: START,
      ownerId: agentId,
      ownerKind: "agent",
      secret: oauthSecret,
      workspaceId: WORKSPACE,
    });

    const result = await resolveOauth();

    expect(headerOf(result)).toBe("Bearer old-access");
    expect(tokenCalls).toBe(0);
  });

  test("a token with less than two minutes left is refreshed first, and version goes to 2", async () => {
    const id = await seedCredential(db, key, {
      connectorId: OAUTH,
      expiresAt: iso(MINUTE_MS),
      now: START,
      ownerId: agentId,
      ownerKind: "agent",
      secret: oauthSecret,
      workspaceId: WORKSPACE,
    });

    const result = await resolveOauth();

    expect(tokenCalls).toBe(1);
    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(headerOf(result)).toBe("Bearer fresh-1");
    const [row] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id));
    expect(row?.refreshingUntil).toBeNull();
    expect(row?.status).toBe("ok");
    expect(Date.parse(row?.expiresAt ?? "")).toBe(nowMs + 3600 * 1000);
  });

  test("an expiring token with no refresh token is used until the server refuses it", async () => {
    await seedCredential(db, key, {
      connectorId: OAUTH,
      expiresAt: iso(MINUTE_MS),
      now: START,
      ownerId: agentId,
      ownerKind: "agent",
      secret: JSON.stringify({ accessToken: "only", refreshToken: null }),
      workspaceId: WORKSPACE,
    });

    const result = await resolveOauth();

    expect(headerOf(result)).toBe("Bearer only");
    expect(tokenCalls).toBe(0);
  });
});

describe("allowed tools", () => {
  test("resolve returns the allowed tools when the assignment sets them", async () => {
    await seedAssignment(db, {
      agentId,
      allowedTools: ["echo", "search"],
      connectorId: CONNECTOR,
      now: START,
      workspaceId: WORKSPACE,
    });
    await addCredential("agent", agentId, "k");

    expect(await resolve(null)).toMatchObject({
      allowedTools: ["echo", "search"],
      ok: true,
    });
  });

  test("resolve returns null allowed tools when the assignment sets none", async () => {
    await assign("agent");
    await addCredential("agent", agentId, "k");

    expect(await resolve(null)).toMatchObject({ allowedTools: null, ok: true });
  });
});

describe("resolveUser", () => {
  const OAUTH = "con_user_oauth";

  const resolveUser = (userId: string, connectorId = CONNECTOR) =>
    service.resolveUser({ connectorId, userId, workspaceId: WORKSPACE });

  test("returns the user's own credential", async () => {
    await addCredential("user", dom, "dom-key");

    const result = await resolveUser(dom);

    expect(headerOf(result)).toBe("dom-key");
    expect(result).toMatchObject({
      allowedTools: null,
      note: null,
      ok: true,
      ownerKind: "user",
    });
  });

  test("never returns another user's or an agent's credential", async () => {
    await addCredential("user", dom, "dom-key");
    await addCredential("agent", agentId, "agent-key");

    expect(await resolveUser(sam)).toEqual({
      cause: "missing",
      connectPath: `/connect/${CONNECTOR}?as=user`,
      ok: false,
      ownerId: sam,
      ownerKind: "user",
      reason: "needs_auth",
    });
  });

  test("a connector with only an agent credential is needs_auth missing", async () => {
    await assign("user_or_agent");
    await addCredential("agent", agentId, "agent-key");

    expect(await resolveUser(dom)).toMatchObject({
      cause: "missing",
      ok: false,
      reason: "needs_auth",
    });
  });

  test("a connector with no auth gives a null credential", async () => {
    await seedConnector(db, {
      authKind: "none",
      id: "con_open",
      now: START,
      workspaceId: WORKSPACE,
    });

    expect(await resolveUser(dom, "con_open")).toMatchObject({
      allowedTools: null,
      credential: null,
      note: null,
      ok: true,
      ownerKind: null,
      version: null,
    });
  });

  test("an unknown connector, or one in another workspace, is not_assigned", async () => {
    await addCredential("user", dom, "dom-key");

    expect(await resolveUser(dom, "con_missing")).toEqual({
      ok: false,
      reason: "not_assigned",
    });
    expect(
      await service.resolveUser({
        connectorId: CONNECTOR,
        userId: dom,
        workspaceId: OTHER_WORKSPACE,
      })
    ).toEqual({ ok: false, reason: "not_assigned" });
  });

  test("an expiring OAuth token is refreshed first", async () => {
    await seedConnector(db, {
      authKind: "oauth",
      id: OAUTH,
      now: START,
      oauth: testOAuthConfig(ORIGIN),
      workspaceId: WORKSPACE,
    });
    await seedCredential(db, key, {
      connectorId: OAUTH,
      expiresAt: iso(MINUTE_MS),
      now: START,
      ownerId: dom,
      ownerKind: "user",
      secret: JSON.stringify({
        accessToken: "old-access",
        refreshToken: "old-refresh",
      }),
      workspaceId: WORKSPACE,
    });

    const result = await resolveUser(dom, OAUTH);

    expect(tokenCalls).toBe(1);
    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(headerOf(result)).toBe("Bearer fresh-1");
  });
});

test("subagents refuse unassigned connectors and narrow connector tool names only", async () => {
  await seedAssignment(db, {
    agentId,
    allowedTools: ["read", "write"],
    connectorId: CONNECTOR,
    credentialMode: "agent",
    now: START,
    workspaceId: WORKSPACE,
  });
  await addCredential("agent", agentId, "agent-key");
  const started = await runs.startRun(sessionUser(dom), {
    agentId,
    input: { text: "parent" },
    session: { origin: "mcp" },
  });
  const parent = { agentId, id: started.runId, workspaceId: WORKSPACE };
  await expect(
    validateSubagentAccess(db, parent, { connectors: ["unassigned"] })
  ).rejects.toThrow("cannot gain connectors");
  const scope = await validateSubagentAccess(db, parent, {
    connectors: [CONNECTOR],
    tools: ["read"],
  });
  db.update(runRows)
    .set({ accessScope: JSON.stringify(scope) })
    .where(eq(runRows.id, started.runId))
    .run();
  const result = await service.resolve({
    agentId,
    connectorId: CONNECTOR,
    onBehalfOfUserId: dom,
    runId: started.runId,
    workspaceId: WORKSPACE,
  });
  expect(result.ok && result.allowedTools).toEqual(["read"]);
  expect(headerOf(result)).toBe("agent-key");
  db.update(runRows)
    .set({ accessScope: JSON.stringify({ connectors: [] }) })
    .where(eq(runRows.id, started.runId))
    .run();
  expect(
    await service.resolve({
      agentId,
      connectorId: CONNECTOR,
      onBehalfOfUserId: dom,
      runId: started.runId,
      workspaceId: WORKSPACE,
    })
  ).toEqual({ ok: false, reason: "not_assigned" });
});
