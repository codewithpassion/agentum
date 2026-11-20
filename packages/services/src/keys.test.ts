import { beforeEach, expect, test } from "bun:test";
import { a2aConnections } from "@repo/db/schema/a2a";
import { agents } from "@repo/db/schema/agents";
import { credentials } from "@repo/db/schema/connectors";
import { agentMailboxes } from "@repo/db/schema/mail";
import { agentSecrets, secrets } from "@repo/db/schema/secrets";
import { slackApps } from "@repo/db/schema/slack";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { workspaces } from "@repo/db/schema/workspaces";
import type { CredentialMode } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { seedAssignment, seedConnector } from "./connectors/test-seed.ts";
import { createKeysService } from "./keys.ts";
import type { Principal } from "./workspaces.ts";

const NOW = "2026-11-20T00:00:00.000Z";
const PRIVATE = "must-never-appear-secret-token";
const user = (
  userId = "member",
  isAdmin = false,
  workspaceId = "w1"
): Principal => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createKeysService>;

beforeEach(async () => {
  db = migrated();
  await db.insert(workspaces).values(
    ["w1", "w2"].map((id) => ({
      clerkOrgId: id,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    }))
  );
  await db.insert(agents).values(
    [
      { id: "a", name: "Alpha", workspaceId: "w1" },
      { id: "b", name: "Beta", workspaceId: "w1" },
      { id: "foreign", name: "Foreign", workspaceId: "w2" },
    ].map((row) => ({
      ...row,
      createdAt: NOW,
      createdBy: "creator",
      instructions: "",
      model: "m",
      runtime: "cloud" as const,
      runtimeConfig: "{}",
      slug: row.id,
      status: "active",
    }))
  );
  service = createKeysService({
    db,
    people: async (ids) =>
      new Map(
        ids.map((id) => [
          id,
          { email: `${id}@private.example`, name: `Person ${id}` },
        ])
      ),
  });
});

const app = async (mode: CredentialMode, connectorId = mode) => {
  await seedConnector(db, {
    authKind: "oauth",
    id: connectorId,
    name: `App ${connectorId}`,
    now: NOW,
    workspaceId: "w1",
  });
  await seedAssignment(db, {
    agentId: "a",
    allowedTools: ["read"],
    connectorId,
    credentialMode: mode,
    now: NOW,
    workspaceId: "w1",
  });
  await db.insert(credentials).values(
    ["a", "b", "member", "other"].map((ownerId) => ({
      connectorId,
      createdAt: NOW,
      createdBy: "creator",
      id: `${connectorId}-${ownerId}`,
      ownerId,
      ownerKind:
        ownerId === "a" || ownerId === "b"
          ? ("agent" as const)
          : ("user" as const),
      secret: PRIVATE,
      status: "ok" as const,
      updatedAt: NOW,
      workspaceId: "w1",
    }))
  );
};

test("apps report modes, allowed tools and the caller's own sign-in without other people's identities", async () => {
  await app("user_or_agent");
  await app("agent");
  await app("user");
  const result = await service.forAgent(user(), "a");
  expect(result.apps).toHaveLength(3);
  for (const row of result.apps) {
    expect(row.allowedTools).toEqual(["read"]);
    expect(row.credentials.hasOwnSignIn).toBe(true);
    expect(row.credentials.agentSignIn).toEqual(
      row.credentialMode === "user"
        ? null
        : { ownerName: "Alpha", status: "ok" }
    );
    expect(row.credentials.otherSignIns).toBeNull();
    expect(row.signIn).toEqual({
      ownerKind: row.credentialMode === "agent" ? "agent" : "user",
      ownerName: row.credentialMode === "agent" ? "Alpha" : "You",
      status: "ok",
    });
  }
  expect(JSON.stringify(result)).not.toContain("Person other");
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
});

test("admins and effective owners see who else signed in, limited to this app and agent", async () => {
  await app("user_or_agent");
  for (const principal of [user("admin", true), user("creator")]) {
    // biome-ignore lint/performance/noAwaitInLoops: exercise each authorized role against the same fixture
    const result = await service.forAgent(principal, "a");
    expect(result.apps.at(0)?.credentials.otherSignIns).toEqual([
      { ownerName: "Person member", status: "ok" },
      { ownerName: "Person other", status: "ok" },
    ]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain("Beta");
  }
  await db
    .update(agents)
    .set({ ownerUserId: "owner" })
    .where(eq(agents.id, "a"));
  expect(
    (await service.forAgent(user("creator"), "a")).apps.at(0)?.credentials
      .otherSignIns
  ).toBeNull();
  expect(
    (await service.forAgent(user("owner"), "a")).apps.at(0)?.credentials
      .otherSignIns
  ).toHaveLength(2);
});

test("user modes never fall back to agent credentials for a caller without a sign-in", async () => {
  await app("user_or_agent");
  await app("agent");
  await app("user");
  const result = await service.forAgent(user("new"), "a");
  for (const row of result.apps) {
    expect(row.credentials.hasOwnSignIn).toBe(false);
    expect(row.signIn).toEqual(
      row.credentialMode === "agent"
        ? { ownerKind: "agent", ownerName: "Alpha", status: "ok" }
        : null
    );
  }
  await db
    .update(credentials)
    .set({ status: "needs_auth" })
    .where(eq(credentials.ownerId, "member"));
  expect(
    (await service.forAgent(user(), "a")).apps.find(
      (row) => row.credentialMode === "user"
    )?.signIn?.status
  ).toBe("needs_auth");
});

test("reads granted secrets, mailbox, Slack, A2A, active handoffs and exact ask overrides without secrets", async () => {
  await db.insert(secrets).values(
    ["env", "proxy", "ungranted"].map((id) => ({
      createdAt: NOW,
      createdBy: "creator",
      id,
      mode: id === "proxy" ? ("proxy" as const) : ("env" as const),
      name: id.toUpperCase(),
      updatedAt: NOW,
      valueEnc: PRIVATE,
      workspaceId: "w1",
    }))
  );
  await db.insert(agentSecrets).values(
    ["env", "proxy"].map((secretId) => ({
      agentId: "a",
      createdAt: NOW,
      secretId,
      workspaceId: "w1",
    }))
  );
  await db.insert(agentMailboxes).values({
    address: "alpha@example.com",
    agentId: "a",
    createdAt: NOW,
    id: "mail",
    status: "active",
    workspaceId: "w1",
  });
  await db.insert(slackApps).values({
    agentId: "a",
    appId: "slack",
    botToken: PRIVATE,
    botUserId: "bot",
    clientSecret: PRIVATE,
    createdAt: NOW,
    id: "slack",
    signingSecret: PRIVATE,
    status: "installed",
    teamId: "team",
    workspaceId: "w1",
  });
  await db.insert(a2aConnections).values({
    createdAt: NOW,
    createdBy: "creator",
    id: "peer",
    inboundTokenHash: PRIVATE,
    localAgentId: "a",
    outboundCredential: PRIVATE,
    peerKind: "a2a_outbound",
    peerLabel: "Peer",
    slug: "peer",
    status: "active",
    workspaceId: "w1",
  });
  await db
    .update(agents)
    .set({
      askLevel: "outside",
      handsTo: JSON.stringify(["b", "foreign", "missing"]),
    })
    .where(eq(agents.id, "a"));
  await db.insert(agentToolRules).values(
    ["ask", "allow"].map((mode) => ({
      agentId: "a",
      id: mode,
      mode: mode as "ask" | "allow",
      toolKey: mode,
      updatedAt: NOW,
      updatedBy: "creator",
      workspaceId: "w1",
    }))
  );
  const result = await service.forAgent(user(), "a");
  expect(result.secrets).toEqual([
    { id: "env", kind: "env", name: "ENV" },
    { id: "proxy", kind: "proxy", name: "PROXY" },
  ]);
  expect(result.identity).toEqual({
    emailAddress: "alpha@example.com",
    slackApp: "installed",
  });
  expect(result.otherAgents).toEqual({
    connections: [
      {
        connectionId: "peer",
        peerKind: "a2a_outbound",
        peerName: "Peer",
        status: "active",
      },
    ],
    handsTo: [{ agentId: "b", name: "Beta" }],
  });
  expect(result.asksBefore).toEqual({
    level: "outside",
    overrides: [
      { mode: "allow", toolKey: "allow" },
      { mode: "ask", toolKey: "ask" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  await db.update(agents).set({ status: "archived" }).where(eq(agents.id, "b"));
  expect((await service.forAgent(user(), "a")).otherAgents.handsTo).toEqual([]);
});

test("an agent with nothing connected has empty parts and its default ask level", async () => {
  expect(await service.forAgent(user(), "a")).toEqual({
    apps: [],
    asksBefore: { level: "rarely", overrides: [] },
    identity: { emailAddress: null, slackApp: null },
    otherAgents: { connections: [], handsTo: [] },
    secrets: [],
  });
});

test("missing and foreign agents are not found; unauthorized callers are refused before reads", async () => {
  await expect(service.forAgent(user(), "foreign")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(service.forAgent(user(), "missing")).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.forAgent(
      { agentId: "a", connectionId: "peer", kind: "peer", workspaceId: "w1" },
      "missing"
    )
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.forAgent({ kind: "system" }, "a")).rejects.toMatchObject(
    { code: "forbidden" }
  );
});

test("revoked credentials retain their status and do not leak tokens; missing credentials are null", async () => {
  await app("agent");
  await db
    .update(credentials)
    .set({ status: "revoked" })
    .where(eq(credentials.ownerId, "a"));
  expect((await service.forAgent(user(), "a")).apps.at(0)?.signIn?.status).toBe(
    "revoked"
  );
  await db.delete(credentials).where(eq(credentials.ownerId, "a"));
  const result = await service.forAgent(user(), "a");
  expect(result.apps.at(0)?.signIn).toBeNull();
  expect(result.apps.at(0)?.credentials.agentSignIn).toBeNull();
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
});

test("other agents' rows and inconsistent foreign-workspace grants never appear", async () => {
  await app("agent");
  await db.insert(secrets).values({
    createdAt: NOW,
    createdBy: "creator",
    id: "foreign-secret",
    mode: "env",
    name: "FOREIGN",
    updatedAt: NOW,
    valueEnc: PRIVATE,
    workspaceId: "w2",
  });
  await db.insert(agentSecrets).values({
    agentId: "a",
    createdAt: NOW,
    secretId: "foreign-secret",
    workspaceId: "w1",
  });
  await db.insert(agentMailboxes).values({
    address: "beta@example.com",
    agentId: "b",
    createdAt: NOW,
    id: "mail-b",
    status: "active",
    workspaceId: "w1",
  });
  await db.insert(a2aConnections).values({
    createdAt: NOW,
    createdBy: "creator",
    id: "peer-b",
    localAgentId: "b",
    peerKind: "a2a_inbound",
    peerLabel: "Other peer",
    slug: "other-peer",
    status: "active",
    workspaceId: "w1",
  });
  await db.insert(slackApps).values({
    agentId: "b",
    appId: "slack-b",
    botUserId: "bot",
    createdAt: NOW,
    id: "slack-b",
    signingSecret: PRIVATE,
    status: "installed",
    teamId: "team",
    workspaceId: "w1",
  });
  await db.insert(agentToolRules).values({
    agentId: "b",
    id: "rule-b",
    mode: "ask",
    toolKey: "bash",
    updatedAt: NOW,
    updatedBy: "creator",
    workspaceId: "w1",
  });
  expect(await service.forAgent(user(), "b")).toMatchObject({
    apps: [],
    secrets: [],
  });
  const result = await service.forAgent(user(), "a");
  expect(result.secrets).toEqual([]);
  expect(result.identity).toEqual({ emailAddress: null, slackApp: null });
  expect(result.otherAgents.connections).toEqual([]);
  expect(result.asksBefore.overrides).toEqual([]);
  await db.update(agents).set({ status: "draft" }).where(eq(agents.id, "a"));
  await expect(service.forAgent(user(), "a")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("Slack uses a non-revoked app; A2A retains connection states and uses a local name fallback", async () => {
  await db.insert(slackApps).values(
    ["revoked", "created"].map((status) => ({
      agentId: "a",
      appId: status,
      botUserId: "bot",
      createdAt: NOW,
      id: status,
      signingSecret: PRIVATE,
      status: status as "revoked" | "created",
      teamId: status,
      workspaceId: "w1",
    }))
  );
  await db.insert(a2aConnections).values(
    ["active", "needs_approval", "revoked"].map((status) => ({
      createdAt: NOW,
      createdBy: "creator",
      id: status,
      localAgentId: "a",
      outboundCredential: PRIVATE,
      peerKind: "a2a_inbound" as const,
      slug: status,
      status: status as "active" | "needs_approval" | "revoked",
      workspaceId: "w1",
    }))
  );
  const result = await service.forAgent(user(), "a");
  expect(result.identity.slackApp).toBe("created");
  expect(result.otherAgents.connections.map((row) => row.status)).toEqual([
    "active",
    "needs_approval",
    "revoked",
  ]);
  expect(
    result.otherAgents.connections.every(
      (row) => row.peerName === row.connectionId
    )
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  await db.update(slackApps).set({ status: "revoked" });
  expect((await service.forAgent(user(), "a")).identity.slackApp).toBeNull();
});
