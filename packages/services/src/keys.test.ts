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
const user = (userId = "member", isAdmin = false, workspaceId = "w1"): Principal => ({
  isAdmin, kind: "user", userId, via: "session", workspaceId,
});
let db: ReturnType<typeof migrated>;
let service: ReturnType<typeof createKeysService>;

beforeEach(async () => {
  db = migrated();
  await db.insert(workspaces).values(["w1", "w2"].map((id) => ({
    clerkOrgId: id, createdAt: NOW, id, name: id, timezone: "UTC",
  })));
  await db.insert(agents).values([
    { id: "a", name: "Alpha", workspaceId: "w1" },
    { id: "b", name: "Beta", workspaceId: "w1" },
    { id: "foreign", name: "Foreign", workspaceId: "w2" },
  ].map((row) => ({
    ...row, createdAt: NOW, createdBy: "creator", instructions: "", model: "m",
    runtime: "cloud" as const, runtimeConfig: "{}", slug: row.id, status: "active",
  })));
  service = createKeysService({ db, people: async (ids) => new Map(ids.map((id) => [id, { name: `Person ${id}` }])) });
});

const app = async (mode: CredentialMode, connectorId = mode) => {
  await seedConnector(db, { authKind: "oauth", id: connectorId, name: `App ${connectorId}`, now: NOW, workspaceId: "w1" });
  await seedAssignment(db, { agentId: "a", allowedTools: ["read"], connectorId, credentialMode: mode, now: NOW, workspaceId: "w1" });
  await db.insert(credentials).values(["a", "b", "member", "other"].map((ownerId) => ({
    connectorId, createdAt: NOW, createdBy: "creator", id: `${connectorId}-${ownerId}`,
    ownerId, ownerKind: ownerId === "a" || ownerId === "b" ? "agent" as const : "user" as const,
    secret: PRIVATE, status: "ok" as const, updatedAt: NOW, workspaceId: "w1",
  })));
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
    expect(row.credentials.otherSignIns).toBeNull();
    expect(row.signIn).toEqual({ ownerKind: row.credentialMode === "agent" ? "agent" : "user", ownerName: row.credentialMode === "agent" ? "Alpha" : "You", status: "ok" });
  }
  expect(JSON.stringify(result)).not.toContain("Person other");
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
});

test("admins and effective owners see who else signed in, limited to this app and agent", async () => {
  await app("user_or_agent");
  for (const principal of [user("admin", true), user("creator")]) {
    const result = await service.forAgent(principal, "a");
    expect(result.apps[0]?.credentials.otherSignIns).toEqual([
      { ownerName: "Person member", status: "ok" },
      { ownerName: "Person other", status: "ok" },
    ]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain("Beta");
  }
  await db.update(agents).set({ ownerUserId: "owner" }).where(eq(agents.id, "a"));
  expect((await service.forAgent(user("creator"), "a")).apps[0]?.credentials.otherSignIns).toBeNull();
  expect((await service.forAgent(user("owner"), "a")).apps[0]?.credentials.otherSignIns).toHaveLength(2);
});

test("user modes never fall back to agent credentials for a caller without a sign-in", async () => {
  await app("user_or_agent");
  await app("agent");
  await app("user");
  const result = await service.forAgent(user("new"), "a");
  for (const row of result.apps) {
    expect(row.credentials.hasOwnSignIn).toBe(false);
    expect(row.signIn).toEqual(row.credentialMode === "agent" ? { ownerKind: "agent", ownerName: "Alpha", status: "ok" } : null);
  }
  await db.update(credentials).set({ status: "needs_auth" }).where(eq(credentials.ownerId, "member"));
  expect((await service.forAgent(user(), "a")).apps.find((row) => row.credentialMode === "user")?.signIn?.status).toBe("needs_auth");
});

test("reads granted secrets, mailbox, Slack, A2A, active handoffs and exact ask overrides without secrets", async () => {
  await db.insert(secrets).values(["env", "proxy", "ungranted"].map((id) => ({
    createdAt: NOW, createdBy: "creator", id, mode: id === "proxy" ? "proxy" as const : "env" as const,
    name: id.toUpperCase(), updatedAt: NOW, valueEnc: PRIVATE, workspaceId: "w1",
  })));
  await db.insert(agentSecrets).values(["env", "proxy"].map((secretId) => ({ agentId: "a", createdAt: NOW, secretId, workspaceId: "w1" })));
  await db.insert(agentMailboxes).values({ address: "alpha@example.com", agentId: "a", createdAt: NOW, id: "mail", status: "active", workspaceId: "w1" });
  await db.insert(slackApps).values({ agentId: "a", appId: "slack", botToken: PRIVATE, botUserId: "bot", clientSecret: PRIVATE, createdAt: NOW, id: "slack", signingSecret: PRIVATE, status: "installed", teamId: "team", workspaceId: "w1" });
  await db.insert(a2aConnections).values({ createdAt: NOW, createdBy: "creator", id: "peer", inboundTokenHash: PRIVATE, localAgentId: "a", outboundCredential: PRIVATE, peerKind: "external", peerLabel: "Peer", slug: "peer", status: "active", workspaceId: "w1" });
  await db.update(agents).set({ askLevel: "outside", handsTo: JSON.stringify(["b", "foreign", "missing"]) }).where(eq(agents.id, "a"));
  await db.insert(agentToolRules).values(["ask", "allow"].map((mode) => ({ agentId: "a", id: mode, mode: mode as "ask" | "allow", toolKey: mode, updatedAt: NOW, updatedBy: "creator", workspaceId: "w1" })));
  const result = await service.forAgent(user(), "a");
  expect(result.secrets).toEqual([{ id: "env", kind: "env", name: "ENV" }, { id: "proxy", kind: "proxy", name: "PROXY" }]);
  expect(result.identity).toEqual({ emailAddress: "alpha@example.com", slackApp: "installed" });
  expect(result.otherAgents).toEqual({ connections: [{ connectionId: "peer", peerKind: "external", peerName: "Peer", status: "active" }], handsTo: [{ agentId: "b", name: "Beta" }] });
  expect(result.asksBefore).toEqual({ level: "outside", overrides: [{ mode: "allow", toolKey: "allow" }, { mode: "ask", toolKey: "ask" }] });
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  await db.update(agents).set({ status: "archived" }).where(eq(agents.id, "b"));
  expect((await service.forAgent(user(), "a")).otherAgents.handsTo).toEqual([]);
});

test("an agent with nothing connected has empty parts and its default ask level", async () => {
  expect(await service.forAgent(user(), "a")).toEqual({ apps: [], asksBefore: { level: "rarely", overrides: [] }, identity: { emailAddress: null, slackApp: null }, otherAgents: { connections: [], handsTo: [] }, secrets: [] });
});

test("missing and foreign agents are not found; unauthorized callers are refused before reads", async () => {
  await expect(service.forAgent(user(), "foreign")).rejects.toMatchObject({ code: "not_found" });
  await expect(service.forAgent(user(), "missing")).rejects.toMatchObject({ code: "not_found" });
  await expect(service.forAgent({ kind: "peer", workspaceId: "w1", agentId: "a", connectionId: "peer" }, "missing")).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.forAgent({ kind: "system" }, "a")).rejects.toMatchObject({ code: "forbidden" });
});
