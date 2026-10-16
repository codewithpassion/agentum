import { afterEach, beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  agentConnectors,
  connectors,
  credentials,
} from "@repo/db/schema/connectors";
import { events as eventsTable } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type StubMcp, startStubMcp } from "../../../scripts/dev/stub-mcp.ts";
import { type AgentRecord, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import { createConnectorsService } from "./connectors.ts";
import { decryptSecret, importSecretsKey } from "./crypto.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
// The guard refuses http and loopback, so the service is given a public-looking
// URL and a fetch that carries it to the stub.
const PUBLIC_ORIGIN = "https://mcp.stub-test.com";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
const TOKEN = "stub-token-1234567890";

const principalOf = (userId: string, workspaceId = WORKSPACE): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const dom = principalOf("user_dom");
const sam = principalOf("user_sam");
const outsider = principalOf("user_dom", OTHER_WORKSPACE);

let db: ReturnType<typeof migrated>;
let stub: StubMcp;
let requested: string[];
let service: ReturnType<typeof createConnectorsService>;
let agents: ReturnType<typeof createAgentsService>;
let events: ReturnType<typeof createEventsService>;
let agent: AgentRecord;

const clock: Clock = {
  now: () => new Date(START),
  sleep: () => Promise.resolve(),
};

const seedWorkspace = (id: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const toStub: Fetcher = (input, init) => {
  const raw = typeof input === "string" ? input : String(input);
  requested.push(raw);
  return fetch(raw.replace(PUBLIC_ORIGIN, new URL(stub.url).origin), init);
};

const build = () => {
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
  agents = createAgentsService({ db, events });
  service = createConnectorsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetch: toStub,
    secretsKey: SECRETS_KEY,
  });
};

beforeEach(async () => {
  db = migrated();
  requested = [];
  stub = startStubMcp({ token: TOKEN });
  seedWorkspace(WORKSPACE);
  seedWorkspace(OTHER_WORKSPACE);
  build();
  agent = await agents.create(dom, {
    model: "claude-sonnet",
    name: "Bruce",
    runtime: "fake",
  });
});

afterEach(() => {
  stub.stop();
});

const only = <T>(items: readonly T[]): T => {
  const [item] = items;
  if (item === undefined) {
    throw new Error("Expected one item.");
  }
  return item;
};

const addHeaderConnector = () =>
  service.create(dom, { name: "Stub", url: `${PUBLIC_ORIGIN}/mcp` });

test("a server that wants a bearer is a header connector, waiting for a credential", async () => {
  const connector = await addHeaderConnector();

  expect(connector).toMatchObject({
    authKind: "header",
    headerName: "Authorization",
    myCredential: null,
    name: "Stub",
    status: "needs_auth",
    tools: [],
    url: `${PUBLIC_ORIGIN}/mcp`,
  });
  expect(connector.agentCredentials).toEqual([]);
});

test("probe lists echo once a credential is pasted", async () => {
  const connector = await addHeaderConnector();

  await service.setCredential(dom, {
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });

  const listed = only(await service.list(dom));
  expect(listed.status).toBe("ok");
  expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
  expect(listed.toolsFetchedAt).toBe(START);
});

test("a server with no auth is probed straight away and lists echo", async () => {
  stub.stop();
  stub = startStubMcp({ token: null });

  const connector = await addHeaderConnector();

  expect(connector).toMatchObject({
    authKind: "none",
    headerName: null,
    status: "ok",
  });
  expect(connector.tools.map((tool) => tool.name)).toEqual(["echo"]);
  expect(
    stub.stats().calls.map((call) => call.headers.authorization)
  ).not.toContain("Bearer");
});

test("a server that points at OAuth metadata is an OAuth connector", async () => {
  const oauthFetch: Fetcher = () =>
    Promise.resolve(
      new Response("", {
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.stub-test.com/.well-known/oauth-protected-resource"',
        },
        status: 401,
      })
    );
  const oauthService = createConnectorsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetch: oauthFetch,
    secretsKey: SECRETS_KEY,
  });

  const connector = await oauthService.create(dom, {
    name: "Notion",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });

  expect(connector).toMatchObject({
    authKind: "oauth",
    headerName: null,
    status: "needs_auth",
  });
});

test.each([
  "https://10.0.0.5/mcp",
  "https://127.0.0.1:8080/mcp",
  "https://192.168.1.10/mcp",
  "https://169.254.169.254/latest/meta-data",
  "https://localhost/mcp",
  "https://[::1]/mcp",
  "http://mcp.stub-test.com/mcp",
])("a private or unsafe URL is refused before any request: %s", async (url) => {
  await expect(service.create(dom, { name: "Bad", url })).rejects.toMatchObject(
    { code: "invalid" }
  );

  expect(requested).toEqual([]);
  expect(stub.stats().calls).toEqual([]);
  expect(await db.select().from(connectors)).toEqual([]);
});

test("an unreachable server is refused and nothing is stored", async () => {
  stub.stop();

  await expect(addHeaderConnector()).rejects.toMatchObject({
    code: "invalid",
  });

  expect(await db.select().from(connectors)).toEqual([]);
});

test("a wrong header value is refused and nothing is stored", async () => {
  const connector = await addHeaderConnector();

  await expect(
    service.setCredential(dom, {
      connectorId: connector.id,
      value: "Bearer not-the-token",
    })
  ).rejects.toMatchObject({ code: "invalid" });

  expect(await db.select().from(credentials)).toEqual([]);
  const after = only(await service.list(dom));
  expect(after.status).toBe("needs_auth");
});

test("the stub receives the pasted header, under the connector's header name", async () => {
  const customFetch: Fetcher = (_input, init) => {
    const headers = new Headers(init?.headers);
    return Promise.resolve(
      headers.get("x-api-key") === "k-123"
        ? Response.json({ id: 1, jsonrpc: "2.0", result: { tools: [] } })
        : new Response("", { status: 401 })
    );
  };
  const keyService = createConnectorsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetch: customFetch,
    secretsKey: SECRETS_KEY,
  });
  const connector = await keyService.create(dom, {
    headerName: "X-Api-Key",
    name: "Keyed",
    url: `${PUBLIC_ORIGIN}/mcp`,
  });
  expect(connector.headerName).toBe("X-Api-Key");

  const credential = await keyService.setCredential(dom, {
    connectorId: connector.id,
    value: "k-123",
  });

  expect(credential.ownerKind).toBe("user");
});

test("the pasted value is stored encrypted and bound to its row", async () => {
  const connector = await addHeaderConnector();
  const value = `Bearer ${TOKEN}`;

  const saved = await service.setCredential(dom, {
    connectorId: connector.id,
    value,
  });

  const [row] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, saved.id));
  expect(row?.secret.startsWith("v1:")).toBe(true);
  expect(row?.secret).not.toContain(TOKEN);
  const key = await importSecretsKey(SECRETS_KEY);
  const binding = {
    field: "secret",
    rowId: saved.id,
    table: "credentials",
    workspaceId: WORKSPACE,
  };
  expect(await decryptSecret(key, binding, row?.secret ?? "")).toBe(value);
  await expect(
    decryptSecret(key, { ...binding, rowId: "other" }, row?.secret ?? "")
  ).rejects.toThrow();
});

test("the stored header value never appears in anything a service returns", async () => {
  const value = `Bearer ${TOKEN}`;
  const connector = await addHeaderConnector();
  const responses: unknown[] = [connector];

  responses.push(
    await service.setCredential(dom, { connectorId: connector.id, value })
  );
  responses.push(
    await service.setCredential(dom, {
      agentId: agent.id,
      connectorId: connector.id,
      value,
    })
  );
  responses.push(
    await service.assign(dom, {
      agentId: agent.id,
      connectorId: connector.id,
    })
  );
  responses.push(await service.assignments(dom, { agentId: agent.id }));
  responses.push(await service.list(dom));
  responses.push(await service.list(sam));
  const refused = await service
    .setCredential(dom, {
      connectorId: connector.id,
      value: `Bearer ${TOKEN}x`,
    })
    .catch((error: unknown) => error);
  responses.push(refused);

  for (const response of responses) {
    const text =
      response instanceof Error
        ? `${response.message} ${response.stack}`
        : JSON.stringify(response);
    expect(text).not.toContain(TOKEN);
  }
  const logged = JSON.stringify(await db.select().from(eventsTable));
  expect(logged).not.toContain(TOKEN);
});

test("a user-owned and an agent-owned header credential coexist for one connector", async () => {
  const connector = await addHeaderConnector();

  const mine = await service.setCredential(dom, {
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });
  const agentOwned = await service.setCredential(dom, {
    agentId: agent.id,
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });

  expect(mine).toMatchObject({
    ownerId: "user_dom",
    ownerKind: "user",
    version: 1,
  });
  expect(agentOwned).toMatchObject({
    ownerId: agent.id,
    ownerKind: "agent",
    version: 1,
  });
  const rows = await db.select().from(credentials);
  expect(rows.map((row) => row.ownerKind).sort()).toEqual(["agent", "user"]);
  expect(new Set(rows.map((row) => row.secret)).size).toBe(2);

  const asDom = only(await service.list(dom));
  expect(asDom.myCredential?.id).toBe(mine.id);
  expect(asDom.agentCredentials.map((credential) => credential.id)).toEqual([
    agentOwned.id,
  ]);
  // Another user sees the agent's credential exists, never Dom's own.
  const asSam = only(await service.list(sam));
  expect(asSam.myCredential).toBeNull();
  expect(asSam.agentCredentials.map((credential) => credential.id)).toEqual([
    agentOwned.id,
  ]);
});

test("pasting again for the same owner replaces the value and bumps the version", async () => {
  const connector = await addHeaderConnector();
  const first = await service.setCredential(dom, {
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });
  const before = only(await db.select().from(credentials));

  const second = await service.setCredential(dom, {
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });

  expect(second.id).toBe(first.id);
  expect(second.version).toBe(2);
  const rows = await db.select().from(credentials);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.secret).not.toBe(before.secret);
});

test("two pastes at once never report a value that was not stored", async () => {
  const connector = await addHeaderConnector();
  await service.setCredential(dom, {
    agentId: agent.id,
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });

  const results = await Promise.allSettled(
    [dom, sam, dom].map((caller) =>
      service.setCredential(caller, {
        agentId: agent.id,
        connectorId: connector.id,
        value: `Bearer ${TOKEN}`,
      })
    )
  );

  const saved = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  for (const result of refused) {
    expect(result.reason).toMatchObject({ code: "conflict" });
  }
  const agentRow = only(
    await db
      .select()
      .from(credentials)
      .where(eq(credentials.ownerKind, "agent"))
  );
  // Every success is one version step, so none was silently dropped.
  expect(agentRow.version).toBe(saved.length);
  expect(saved.length).toBeGreaterThan(0);
});

test("a credential cannot be pasted for a connector that needs no header", async () => {
  stub.stop();
  stub = startStubMcp({ token: null });
  const connector = await addHeaderConnector();

  await expect(
    service.setCredential(dom, { connectorId: connector.id, value: "x" })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("an agent-owned credential needs an active agent of the same workspace", async () => {
  const connector = await addHeaderConnector();
  const value = `Bearer ${TOKEN}`;

  await expect(
    service.setCredential(dom, {
      agentId: "missing",
      connectorId: connector.id,
      value,
    })
  ).rejects.toMatchObject({ code: "not_found" });
  await agents.archive(dom, agent.id);
  await expect(
    service.setCredential(dom, {
      agentId: agent.id,
      connectorId: connector.id,
      value,
    })
  ).rejects.toMatchObject({ code: "invalid" });
});

test("assign defaults to user_or_agent, changes the mode, and unassign removes it", async () => {
  const connector = await addHeaderConnector();

  const first = await service.assign(dom, {
    agentId: agent.id,
    connectorId: connector.id,
  });
  expect(first.credentialMode).toBe("user_or_agent");

  const changed = await service.assign(dom, {
    agentId: agent.id,
    connectorId: connector.id,
    credentialMode: "agent",
  });
  expect(changed.credentialMode).toBe("agent");
  expect(await db.select().from(agentConnectors)).toHaveLength(1);
  expect(await service.assignments(dom, { agentId: agent.id })).toEqual([
    changed,
  ]);

  expect(
    await service.unassign(dom, {
      agentId: agent.id,
      connectorId: connector.id,
    })
  ).toEqual({ removed: true });
  expect(await service.assignments(dom, { agentId: agent.id })).toEqual([]);
  expect(
    await service.unassign(dom, {
      agentId: agent.id,
      connectorId: connector.id,
    })
  ).toEqual({ removed: false });
});

test("another workspace cannot see or use a connector", async () => {
  const connector = await addHeaderConnector();

  expect(await service.list(outsider)).toEqual([]);
  await expect(
    service.setCredential(outsider, {
      connectorId: connector.id,
      value: `Bearer ${TOKEN}`,
    })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.assign(outsider, { agentId: agent.id, connectorId: connector.id })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("only a signed-in user may manage connectors", async () => {
  const run: Principal = {
    agentId: agent.id,
    kind: "run",
    runId: "r1",
    workspaceId: WORKSPACE,
  };
  const key: Principal = {
    kind: "user",
    userId: "user_dom",
    via: "api_key",
    workspaceId: WORKSPACE,
  };

  const attempts = [run, key].flatMap((caller) => [
    service.create(caller, { name: "x", url: `${PUBLIC_ORIGIN}/mcp` }),
    service.list(caller),
  ]);
  await Promise.all(
    attempts.map((attempt) =>
      expect(attempt).rejects.toBeInstanceOf(ForbiddenError)
    )
  );
});

test("credential.created is logged for each paste, without the value", async () => {
  const connector = await addHeaderConnector();

  await service.setCredential(dom, {
    agentId: agent.id,
    connectorId: connector.id,
    value: `Bearer ${TOKEN}`,
  });

  const logged = await events.query({ kind: "system" }, WORKSPACE, {
    types: ["credential.created"],
  });
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    actor: { id: "user_dom", kind: "user" },
    agentId: agent.id,
    payload: {
      connectorId: connector.id,
      ownerId: agent.id,
      ownerKind: "agent",
      replaced: false,
    },
  });
});
