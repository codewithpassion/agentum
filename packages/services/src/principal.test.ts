import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { apiKeys } from "@repo/db/schema/api-keys";
import { machines } from "@repo/db/schema/machines";
import { managedSessions } from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { hashedToken } from "./crypto.ts";
import {
  importRunTokenKey,
  signRunToken,
  signSessionToken,
} from "./run-tokens.ts";
import {
  createPrincipalResolver,
  type VerifiedOAuthClaim,
} from "./workspaces.ts";

const keyBase64 = (fill: number) =>
  Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");

const MINUTE_MS = 60 * 1000;
const bearer = (token: string) => `Bearer ${token}`;

let db: ReturnType<typeof migrated>;
let runKey: CryptoKey;
let clock: number;
let members: Set<string>;
let memberCalls: number;
let memberOutage: boolean;
let oauthAnswer: VerifiedOAuthClaim | null;
let oauthCalls: number;
let oauthOutage: boolean;

const claim = { access: "read", clientId: "client_1" } as const;

const isOrgMember = (userId: string, clerkOrgId: string): Promise<boolean> => {
  memberCalls += 1;
  return memberOutage
    ? Promise.reject(new Error("clerk outage"))
    : Promise.resolve(members.has(`${userId}@${clerkOrgId}`));
};

const verifyClerkOAuthToken = (
  _token: string
): Promise<VerifiedOAuthClaim | null> => {
  oauthCalls += 1;
  return oauthOutage
    ? Promise.reject(new Error("clerk outage"))
    : Promise.resolve(oauthAnswer);
};

const resolverFor = (allowedOrgIds: readonly string[] = ["org_a"]) =>
  createPrincipalResolver({
    allowedOrgIds,
    db,
    isOrgMember,
    now: () => clock,
    runTokenKey: runKey,
    verifyClerkOAuthToken,
  });

const addWorkspace = (id: string, clerkOrgId: string) =>
  db
    .insert(workspaces)
    .values({
      clerkOrgId,
      createdAt: new Date().toISOString(),
      id,
      name: clerkOrgId,
      timezone: "UTC",
    })
    .run();

const addAgent = (id: string, workspaceId: string) =>
  db
    .insert(agents)
    .values({
      createdAt: new Date().toISOString(),
      createdBy: "user_1",
      id,
      instructions: "",
      model: "test-model",
      name: id,
      runtime: "managed",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId,
    })
    .run();

const addSession = (id: string, workspaceId: string, agentId: string) =>
  db
    .insert(sessions)
    .values({
      actorId: "user_1",
      actorKind: "user",
      agentId,
      createdAt: new Date().toISOString(),
      id,
      origin: "test",
      workspaceId,
    })
    .run();

const addMachine = async (
  id: string,
  workspaceId: string,
  status: "online" | "revoked"
) => {
  const { hash, token } = await hashedToken("hm_mach_");
  db.insert(machines)
    .values({
      capabilities: "[]",
      createdAt: new Date().toISOString(),
      credentialHash: hash,
      enrolledBy: "user_1",
      id,
      name: id,
      singleUser: false,
      status,
      workspaceId,
    })
    .run();
  return token;
};

const addTrigger = async (id: string, workspaceId: string, agentId: string) => {
  const { hash, token } = await hashedToken("hm_trg_");
  db.insert(triggers)
    .values({
      agentId,
      createdAt: new Date().toISOString(),
      createdBy: "u1",
      id,
      kind: "http",
      name: "t",
      tokenHash: hash,
      tokenPrefix: token.slice(0, 11),
      workspaceId,
    })
    .run();
  return token;
};

const addApiKey = async (
  id: string,
  workspaceId: string,
  createdBy: string,
  revoked: boolean
) => {
  const { hash, token } = await hashedToken("hm_key_");
  db.insert(apiKeys)
    .values({
      access: "write",
      createdAt: new Date().toISOString(),
      createdBy,
      id,
      keyHash: hash,
      name: id,
      prefix: "hm_key_",
      revokedAt: revoked ? new Date().toISOString() : null,
      workspaceId,
    })
    .run();
  return token;
};

/** A live run, so a token minted now is accepted now. */
const addRun = (
  id: string,
  workspaceId: string,
  agentId: string,
  sessionId: string
) => {
  const now = Date.now();
  db.insert(runs)
    .values({
      actorId: "user_1",
      actorKind: "user",
      agentId,
      createdAt: new Date(now).toISOString(),
      id,
      inputText: "hello",
      leaseUntil: new Date(now + 5 * MINUTE_MS).toISOString(),
      sessionId,
      status: "running",
      workspaceId,
    })
    .run();
};

const runTokenFor = (runId: string, workspaceId: string, agentId: string) =>
  signRunToken(runKey, {
    agentId,
    issuedAt: Date.now(),
    runId,
    workspaceId,
  });

let tokens: {
  apiKey: string;
  apiKeyRevoked: string;
  machine: string;
  machineRevoked: string;
  trigger: string;
};
let runToken: string;
let otherOrgTokens: { apiKey: string; machine: string; trigger: string };
let otherOrgRunToken: string;

beforeEach(async () => {
  db = migrated();
  runKey = await importRunTokenKey(keyBase64(1));
  clock = 0;
  members = new Set(["user_1@org_a"]);
  memberCalls = 0;
  memberOutage = false;
  oauthAnswer = null;
  oauthCalls = 0;
  oauthOutage = false;

  addWorkspace("ws_a", "org_a");
  addWorkspace("ws_x", "org_x");
  addAgent("agent_1", "ws_a");
  addAgent("agent_9", "ws_x");
  addSession("session_1", "ws_a", "agent_1");
  addSession("session_9", "ws_x", "agent_9");
  tokens = {
    apiKey: await addApiKey("key_a", "ws_a", "user_1", false),
    apiKeyRevoked: await addApiKey("key_a_revoked", "ws_a", "user_1", true),
    machine: await addMachine("mach_a", "ws_a", "online"),
    machineRevoked: await addMachine("mach_a_revoked", "ws_a", "revoked"),
    trigger: await addTrigger("trg_a", "ws_a", "agent_1"),
  };
  otherOrgTokens = {
    apiKey: await addApiKey("key_x", "ws_x", "user_1", false),
    machine: await addMachine("mach_x", "ws_x", "online"),
    trigger: await addTrigger("trg_x", "ws_x", "agent_9"),
  };
  addRun("run_1", "ws_a", "agent_1", "session_1");
  addRun("run_x", "ws_x", "agent_9", "session_9");
  runToken = await runTokenFor("run_1", "ws_a", "agent_1");
  otherOrgRunToken = await runTokenFor("run_x", "ws_x", "agent_9");
});

test("a run token resolves to a run principal", async () => {
  expect(await resolverFor().resolve(bearer(runToken))).toEqual({
    agentId: "agent_1",
    dryRun: false,
    kind: "run",
    runId: "run_1",
    workspaceId: "ws_a",
  });
});

test("a run token of a dry run resolves to a run principal with dryRun set, read from the live row", async () => {
  db.update(runs).set({ dryRun: true }).where(eq(runs.id, "run_1")).run();
  expect(await resolverFor().resolve(bearer(runToken))).toMatchObject({
    dryRun: true,
    kind: "run",
    runId: "run_1",
  });
});

test("a managed session token resolves to a run principal for the session's running run", async () => {
  const issuedAt = Date.now();
  db.update(runs)
    .set({ claimedBy: "managed" })
    .where(eq(runs.id, "run_1"))
    .run();
  db.insert(managedSessions)
    .values({
      agentFingerprint: "fp",
      anthropicSessionId: "sesn_1",
      createdAt: new Date().toISOString(),
      currentRunId: "run_1",
      sessionId: "session_1",
      tokenIssuedAt: issuedAt,
      vaultId: "vlt_1",
      workspaceId: "ws_a",
    })
    .run();
  const token = await signSessionToken(runKey, {
    agentId: "agent_1",
    issuedAt,
    sessionId: "session_1",
    workspaceId: "ws_a",
  });

  expect(await resolverFor().resolve(bearer(token))).toEqual({
    agentId: "agent_1",
    dryRun: false,
    kind: "run",
    runId: "run_1",
    workspaceId: "ws_a",
  });
  // The same token with a session that has no managed row resolves to nothing.
  const stranger = await signSessionToken(runKey, {
    agentId: "agent_9",
    issuedAt,
    sessionId: "session_9",
    workspaceId: "ws_x",
  });
  expect(await resolverFor(["org_a", "org_x"]).resolve(bearer(stranger))).toBe(
    null
  );
});

test("a machine token resolves to a machine principal", async () => {
  expect(await resolverFor().resolve(bearer(tokens.machine))).toEqual({
    kind: "machine",
    machineId: "mach_a",
    workspaceId: "ws_a",
  });
});

test("a revoked trigger's token resolves to null", async () => {
  db.update(triggers)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(triggers.id, "trg_a"))
    .run();
  expect(await resolverFor().resolve(bearer(tokens.trigger))).toBeNull();
});

test("a trigger token resolves to a trigger principal", async () => {
  expect(await resolverFor().resolve(bearer(tokens.trigger))).toEqual({
    agentId: "agent_1",
    kind: "trigger",
    triggerId: "trg_a",
    workspaceId: "ws_a",
  });
});

test("an api key resolves to the user who minted it, when that user is still a member", async () => {
  expect(await resolverFor().resolve(bearer(tokens.apiKey))).toEqual({
    apiKey: { access: "write", id: "key_a" },
    kind: "user",
    userId: "user_1",
    via: "api_key",
    workspaceId: "ws_a",
  });
});

test("the Bearer scheme is case insensitive", async () => {
  expect(await resolverFor().resolve(`bearer ${tokens.machine}`)).toMatchObject(
    { kind: "machine" }
  );
});

test("a revoked machine, a revoked api key and an unknown hm_ prefix resolve to null", async () => {
  const { resolve } = resolverFor();
  expect(await resolve(bearer(tokens.machineRevoked))).toBeNull();
  expect(await resolve(bearer(tokens.apiKeyRevoked))).toBeNull();
  expect(await resolve(bearer("hm_xxx_abcdef"))).toBeNull();
  expect(oauthCalls).toBe(0);
});

test("a token without the hm_ prefix goes to the OAuth verifier and resolves to an oauth principal", async () => {
  oauthAnswer = { ...claim, userId: "user_2", workspaceId: "ws_a" };
  members.add("user_2@org_a");
  expect(await resolverFor().resolve(bearer("oauth-token"))).toEqual({
    kind: "user",
    oauthClient: { access: "read", clientId: "client_1" },
    userId: "user_2",
    via: "oauth",
    workspaceId: "ws_a",
  });
  expect(oauthCalls).toBe(1);
});

test("an OAuth token the verifier refuses resolves to null", async () => {
  oauthAnswer = null;
  expect(await resolverFor().resolve(bearer("oauth-token"))).toBeNull();
  expect(oauthCalls).toBe(1);
});

test("an hm_enr_ token resolves to null and never reaches the OAuth verifier", async () => {
  expect(await resolverFor().resolve(bearer("hm_enr_abcdef"))).toBeNull();
  expect(oauthCalls).toBe(0);
});

test("an api key whose minter is no longer a member resolves to null", async () => {
  members.delete("user_1@org_a");
  expect(await resolverFor().resolve(bearer(tokens.apiKey))).toBeNull();
});

test("an oauth principal who is not a member resolves to null", async () => {
  oauthAnswer = { ...claim, userId: "user_2", workspaceId: "ws_a" };
  expect(await resolverFor().resolve(bearer("oauth-token"))).toBeNull();
});

test("tokens of workspaces outside allowedOrgIds resolve to null", async () => {
  oauthAnswer = { ...claim, userId: "user_1", workspaceId: "ws_x" };
  members.add("user_1@org_x");
  const { resolve } = resolverFor();
  expect(await resolve(bearer(otherOrgRunToken))).toBeNull();
  expect(await resolve(bearer(otherOrgTokens.machine))).toBeNull();
  expect(await resolve(bearer(otherOrgTokens.trigger))).toBeNull();
  expect(await resolve(bearer(otherOrgTokens.apiKey))).toBeNull();
  expect(await resolve(bearer("oauth-token"))).toBeNull();
});

test("a missing, empty or malformed Authorization header resolves to null", async () => {
  const { resolve } = resolverFor();
  const malformed = [
    null,
    "",
    "Bearer",
    "Bearer ",
    `Bearer  ${tokens.apiKey}`,
    `Bearer ${tokens.apiKey} extra`,
    `Basic ${tokens.apiKey}`,
    tokens.apiKey,
    `Bearer${tokens.apiKey}`,
  ];
  const results = await Promise.all(malformed.map((header) => resolve(header)));
  expect(results).toEqual(malformed.map(() => null));
});

test("membership is checked once for two resolves within 60 seconds, and again after 61 seconds", async () => {
  const { resolve } = resolverFor();
  expect(await resolve(bearer(tokens.apiKey))).toMatchObject({ kind: "user" });
  clock += 30_000;
  expect(await resolve(bearer(tokens.apiKey))).toMatchObject({ kind: "user" });
  expect(memberCalls).toBe(1);

  clock += 31_000;
  expect(await resolve(bearer(tokens.apiKey))).toMatchObject({ kind: "user" });
  expect(memberCalls).toBe(2);
});

test("a person who left the org loses access once the cached answer expires", async () => {
  const { resolve } = resolverFor();
  expect(await resolve(bearer(tokens.apiKey))).toMatchObject({ kind: "user" });
  members.delete("user_1@org_a");
  clock += 30_000;
  expect(await resolve(bearer(tokens.apiKey))).toMatchObject({ kind: "user" });
  clock += 31_000;
  expect(await resolve(bearer(tokens.apiKey))).toBeNull();
});

test("a negative membership answer is cached too", async () => {
  members.delete("user_1@org_a");
  const { resolve } = resolverFor();
  expect(await resolve(bearer(tokens.apiKey))).toBeNull();
  clock += 30_000;
  expect(await resolve(bearer(tokens.apiKey))).toBeNull();
  expect(memberCalls).toBe(1);
});

test("an isOrgMember error rejects instead of resolving to null", async () => {
  memberOutage = true;
  await expect(resolverFor().resolve(bearer(tokens.apiKey))).rejects.toThrow(
    "clerk outage"
  );
});

test("a verifyClerkOAuthToken error rejects instead of resolving to null", async () => {
  oauthOutage = true;
  await expect(resolverFor().resolve(bearer("oauth-token"))).rejects.toThrow(
    "clerk outage"
  );
});
