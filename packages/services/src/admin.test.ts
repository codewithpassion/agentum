import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { connectors as connectorRows } from "@repo/db/schema/connectors";
import { events as eventRows } from "@repo/db/schema/events";
import { workspaces } from "@repo/db/schema/workspaces";
import type { ApiKeyAccess } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { type AdminService, createAdminService } from "./admin.ts";
import { withinScope } from "./admin-access.ts";
import { createAgentsService } from "./agents.ts";
import { createApiKeysService } from "./api-keys.ts";
import { ForbiddenError } from "./authz.ts";
import { createConnectorsService } from "./connectors.ts";
import { createEventsService, type EventsService } from "./events.ts";
import { createInboxService } from "./inbox.ts";
import { createMachinesService } from "./machines.ts";
import type { Clock } from "./runs/types.ts";
import { createSecretsService, type SecretsService } from "./secrets.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-27T10:00:00.000Z";
const SECRETS_KEY = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32))
).toString("base64");
const SECRET_VALUE = "sk-live-0123456789abcdef-VALUE";

const keyPrincipal = (access: ApiKeyAccess, id = `k-${access}`): Principal => ({
  apiKey: { access, id, name: `${access} key` },
  kind: "user",
  userId: "u1",
  via: "api_key",
  workspaceId: WORKSPACE,
});
const adminKey = keyPrincipal("admin");
const writeKey = keyPrincipal("write");
const readKey = keyPrincipal("read");
const session: Principal = {
  isAdmin: true,
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let admin: AdminService;
let secrets: SecretsService;
let events: EventsService;
let apiKeysService: ReturnType<typeof createApiKeysService>;
let agentsService: ReturnType<typeof createAgentsService>;
let connectorsService: ReturnType<typeof createConnectorsService>;

const clock: Clock = {
  now: () => new Date(START),
  sleep: () => Promise.resolve(),
};

const adminEvents = () =>
  db
    .select()
    .from(eventRows)
    .all()
    .filter((row) => row.type === "admin.action");

const everyEventText = () => JSON.stringify(db.select().from(eventRows).all());

beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const atomic = sqliteAtomic(db);
  events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  agentsService = agents;
  apiKeysService = createApiKeysService({ clock, db, events });
  secrets = createSecretsService({
    atomic,
    clock,
    db,
    events,
    secretsKey: SECRETS_KEY,
  });
  connectorsService = createConnectorsService({
    atomic,
    clock,
    db,
    events,
    fetch: () => Promise.reject(new Error("no network in tests")),
    secretsKey: SECRETS_KEY,
  });
  admin = createAdminService({
    agents,
    apiKeys: apiKeysService,
    connectors: connectorsService,
    events,
    inbox: createInboxService({
      atomic,
      clock,
      db,
      events,
      runs: { startRun: () => Promise.reject(new Error("no runs in tests")) },
    }),
    machines: createMachinesService({
      allowedOrgIds: ["org_w1"],
      atomic,
      clock,
      db,
      events,
      relay: {} as never,
    }),
    secrets,
  });
});

const agentInput = { model: "m", name: "Support", runtime: "managed" } as const;

describe("who may call", () => {
  test("a write key is refused every setup call", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () =>
        admin.createSecret(writeKey, {
          mode: "env",
          name: "TOKEN_A",
          value: SECRET_VALUE,
        }),
      () => admin.grantSecret(writeKey, { agentId: "a", secretId: "s" }),
      () => admin.revokeSecret(writeKey, { agentId: "a", secretId: "s" }),
      () => admin.createEnrolmentCode(writeKey, { machineName: "box" }),
      () => admin.createApiKey(writeKey, { access: "read", name: "k" }),
      () => admin.revokeApiKey(writeKey, { keyId: "k" }),
    ];
    await Promise.all(
      calls.map((call) => expect(call()).rejects.toBeInstanceOf(ForbiddenError))
    );
    expect(adminEvents()).toHaveLength(0);
  });

  test("only a write or admin key creates agents and inbox threads", async () => {
    await Promise.all(
      [readKey, keyPrincipal("desk"), session].flatMap((principal) => [
        expect(admin.createAgent(principal, agentInput)).rejects.toBeInstanceOf(
          ForbiddenError
        ),
        expect(
          admin.createInboxThread(principal, { title: "t" })
        ).rejects.toBeInstanceOf(ForbiddenError),
      ])
    );
    await expect(
      admin.createAgent(writeKey, agentInput)
    ).resolves.toMatchObject({ name: "Support" });
    await expect(
      admin.createInboxThread(adminKey, { title: "t" })
    ).resolves.toMatchObject({ title: "t" });
  });
});

describe("an admin key", () => {
  test("creates and updates an agent, with connectors and runtime settings", async () => {
    const agent = await admin.createAgent(adminKey, {
      ...agentInput,
      environment: "linux-vm",
      maxTurns: 40,
      networkAccess: false,
      runtime: "cloud",
    });
    expect(agent.runtimeConfig).toEqual({
      environment: "linux-vm",
      maxTurns: 40,
      networkAccess: false,
    });
    const updated = await admin.updateAgent(adminKey, {
      agentId: agent.id,
      instructions: "Be brief.",
      maxTurns: 60,
    });
    expect(updated.instructions).toBe("Be brief.");
    expect(updated.runtimeConfig).toEqual({
      environment: "linux-vm",
      maxTurns: 60,
      networkAccess: false,
    });
  });

  test("a write key creates an agent with connectors; an unknown connector fails before the agent exists", async () => {
    db.insert(connectorRows)
      .values({
        authKind: "none",
        createdAt: START,
        createdBy: "u1",
        id: "c1",
        name: "docs",
        status: "ok",
        url: "https://docs.example.com/mcp",
        workspaceId: WORKSPACE,
      })
      .run();
    await expect(
      admin.createAgent(writeKey, { ...agentInput, connectors: ["nope"] })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(adminEvents()).toHaveLength(0);
    const agent = await admin.createAgent(writeKey, {
      ...agentInput,
      connectors: ["c1"],
    });
    // Updating with the same connector leaves the assignment alone.
    await admin.updateAgent(writeKey, {
      agentId: agent.id,
      connectors: ["c1"],
      name: "Help",
    });
    expect(adminEvents()).toHaveLength(2);
  });

  test("a repeat update keeps the credential mode of a connector the agent holds", async () => {
    db.insert(connectorRows)
      .values({
        authKind: "none",
        createdAt: START,
        createdBy: "u1",
        id: "c1",
        name: "docs",
        status: "ok",
        url: "https://docs.example.com/mcp",
        workspaceId: WORKSPACE,
      })
      .run();
    const agent = await admin.createAgent(writeKey, agentInput);
    await connectorsService.assign(session, {
      agentId: agent.id,
      connectorId: "c1",
      credentialMode: "agent",
    });
    await admin.updateAgent(writeKey, {
      agentId: agent.id,
      connectors: ["c1"],
      name: "Help",
    });
    expect(
      await connectorsService.assignments(session, { agentId: agent.id })
    ).toMatchObject([{ connectorId: "c1", credentialMode: "agent" }]);
  });

  test("update_agent on an archived agent fails before it saves or writes an event", async () => {
    const agent = await admin.createAgent(writeKey, agentInput);
    await agentsService.archive(session, agent.id);
    const before = everyEventText();
    await expect(
      admin.updateAgent(writeKey, { agentId: agent.id, name: "Help" })
    ).rejects.toMatchObject({ code: "invalid" });
    expect((await agentsService.get(session, agent.id)).name).toBe("Support");
    expect(everyEventText()).toBe(before);
  });

  test("a runtime setting change loses to a concurrent one instead of overwriting it", async () => {
    const agent = await admin.createAgent(adminKey, {
      ...agentInput,
      runtime: "cloud",
    });
    const results = await Promise.allSettled([
      admin.updateAgent(adminKey, { agentId: agent.id, maxTurns: 10 }),
      admin.updateAgent(adminKey, { agentId: agent.id, networkAccess: false }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "conflict" } });
  });

  test("creates a proxy secret, grants it, revokes it, and never leaks the value", async () => {
    const agent = await admin.createAgent(adminKey, agentInput);
    const secret = await admin.createSecret(adminKey, {
      mode: "proxy",
      name: "OPENAI_KEY",
      rules: [
        {
          header: "Authorization",
          host: "api.openai.com",
          template: "Bearer {value}",
        },
      ],
      value: SECRET_VALUE,
    });
    expect(JSON.stringify(secret)).not.toContain(SECRET_VALUE);
    await admin.grantSecret(adminKey, {
      agentId: agent.id,
      secretId: secret.id,
    });
    await admin.grantSecret(adminKey, {
      agentId: agent.id,
      secretId: secret.id,
    });
    expect(await secrets.grantsOf(adminKey, agent.id)).toEqual([secret.id]);
    await admin.revokeSecret(adminKey, {
      agentId: agent.id,
      secretId: secret.id,
    });
    expect(await secrets.grantsOf(adminKey, agent.id)).toEqual([]);
    expect(everyEventText()).not.toContain(SECRET_VALUE);
  });

  test("creates an inbox thread and an enrolment code, and the events hold neither the code nor the thread text", async () => {
    const thread = await admin.createInboxThread(adminKey, { title: "Setup" });
    expect(thread.id).not.toBe("");
    const { code, expiresAt } = await admin.createEnrolmentCode(adminKey, {
      machineName: "build box",
    });
    expect(code).not.toBe("");
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.parse(START));
    expect(everyEventText()).not.toContain(code);
  });

  test("mints a desk key and an admin key, then revokes one; the secret is never in an event", async () => {
    const desk = await admin.createApiKey(adminKey, {
      access: "desk",
      name: "desk",
    });
    expect(desk.secret.startsWith("hm_key_")).toBe(true);
    expect(desk.key.access).toBe("desk");
    const revoked = await admin.revokeApiKey(adminKey, { keyId: desk.key.id });
    expect(revoked.revokedAt).not.toBeNull();
    const second = await admin.createApiKey(adminKey, {
      access: "admin",
      name: "second admin",
    });
    expect(second.key.access).toBe("admin");
    expect(everyEventText()).not.toContain(desk.secret);
    expect(everyEventText()).not.toContain(second.secret);
  });

  test("every call writes one admin.action event naming the key", async () => {
    const agent = await admin.createAgent(adminKey, agentInput);
    expect(adminEvents()).toHaveLength(1);
    await admin.updateAgent(adminKey, { agentId: agent.id, name: "Help" });
    await admin.createInboxThread(adminKey, { title: "t" });
    const secret = await admin.createSecret(adminKey, {
      mode: "env",
      name: "PLAIN_ENV",
      value: SECRET_VALUE,
    });
    await admin.grantSecret(adminKey, {
      agentId: agent.id,
      secretId: secret.id,
    });
    await admin.revokeSecret(adminKey, {
      agentId: agent.id,
      secretId: secret.id,
    });
    await admin.createEnrolmentCode(adminKey, { machineName: "box" });
    const minted = await admin.createApiKey(adminKey, {
      access: "read",
      name: "r",
    });
    await admin.revokeApiKey(adminKey, { keyId: minted.key.id });
    const rows = adminEvents();
    expect(rows.map((row) => JSON.parse(row.payload ?? "{}").tool)).toEqual([
      "create_agent",
      "update_agent",
      "create_inbox_thread",
      "create_secret",
      "grant_secret",
      "revoke_secret",
      "create_enrolment_code",
      "create_api_key",
      "revoke_api_key",
    ]);
    for (const row of rows) {
      expect(row.actorKind).toBe("api_key");
      expect(row.actorId).toBe("k-admin");
      expect(JSON.parse(row.payload ?? "{}")).toMatchObject({
        keyId: "k-admin",
        keyName: "admin key",
      });
    }
  });

  test("audit records a call another path made, for keys only", async () => {
    await admin.audit(writeKey, "assign_skill", { skillId: "s1" });
    await admin.audit(session, "assign_skill", { skillId: "s1" });
    expect(adminEvents()).toHaveLength(1);
  });
});

describe("key scopes", () => {
  test("a key mints no wider scope than its own", () => {
    expect(withinScope("write", "admin")).toBe(false);
    expect(withinScope("read", "write")).toBe(false);
    expect(withinScope("write", "read")).toBe(true);
    expect(withinScope("admin", "admin")).toBe(true);
    expect(withinScope("admin", "desk")).toBe(true);
  });

  test("a session mints an admin key only as an organisation admin", async () => {
    const member: Principal = { ...session, isAdmin: false } as Principal;
    await expect(
      apiKeysService.create(member, { access: "admin", name: "x" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      apiKeysService.create(member, { access: "write", name: "x" })
    ).resolves.toBeDefined();
    await expect(
      apiKeysService.create(session, { access: "admin", name: "x" })
    ).resolves.toMatchObject({ key: { access: "admin" } });
  });

  test("a write key cannot mint keys at all", async () => {
    await expect(
      apiKeysService.create(writeKey, { access: "write", name: "x" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
