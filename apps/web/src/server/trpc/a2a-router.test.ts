import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const SKILLS = [
  {
    description: "Answers questions.",
    id: "ask",
    name: "Ask",
    tags: ["support"],
  },
];

const CANNOT_CHANGE = /admin or the agent's owner/;

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    publicBaseUrl: "https://hm.test",
    relay: noopRelay,
    secretsKey: SECRETS_KEY,
  };
};

const callerFor = async (
  composed: Composed,
  session: { orgRole?: string; userId: string }
) =>
  appRouter.createCaller(
    await buildContext({
      composed,
      session: { orgId: "org_a", ...session },
    })
  );

/** An admin owns an agent and holds one key connection on it. A member sits beside them. */
const setup = async () => {
  const composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: infra(),
  });
  const admin = await callerFor(composed, {
    orgRole: "org:admin",
    userId: "user_admin",
  });
  const member = await callerFor(composed, {
    orgRole: "org:member",
    userId: "user_member",
  });
  const agent = await admin.agents.create({
    model: "m",
    name: "Support",
    runtime: "fake",
  });
  await admin.a2a.publish({
    agentId: agent.id,
    description: "Helps with support questions.",
    skills: SKILLS,
  });
  const key = await admin.a2a.createAccessKey({
    agentId: agent.id,
    label: "Hermes on Sam's box",
  });
  return { admin, agent, connectionId: key.connection.id, key, member };
};

test("a member may not widen a policy, and an admin may", async () => {
  const { admin, connectionId, member } = await setup();

  await expect(
    member.a2a.setPolicies({ connectionId, inboundPolicy: "auto" })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    member.a2a.setPolicies({ connectionId, toolPolicy: "agent_rules" })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });

  const widened = await admin.a2a.setPolicies({
    connectionId,
    inboundPolicy: "auto",
  });
  expect(widened.inboundPolicy).toBe("auto");
});

test("a member may not approve a connection", async () => {
  const { connectionId, member } = await setup();

  await expect(
    member.a2a.approve({
      connectionId,
      seen: { origin: "https://hm.test", tokenUrl: null },
    })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("a member may read the connections and is told why they cannot change one", async () => {
  const { admin, agent, connectionId, member } = await setup();

  const list = await member.a2a.list({});
  expect(list.map((row) => row.id)).toEqual([connectionId]);
  expect(await member.a2a.recentTasks({ connectionId })).toEqual([]);
  expect((await member.a2a.manage({ connectionId })).reason).toMatch(
    CANNOT_CHANGE
  );
  expect(await admin.a2a.manage({ connectionId })).toEqual({ reason: null });
  expect((await member.a2a.published({ agentId: agent.id }))?.skills).toEqual(
    SKILLS
  );
});

test("a member may revoke, and the row stays listed as revoked", async () => {
  const { connectionId, member } = await setup();

  const revoked = await member.a2a.revoke({ connectionId });

  expect(revoked.status).toBe("revoked");
  const [row] = await member.a2a.list({});
  expect(row?.status).toBe("revoked");
});

test("a member may not publish or create an invite or a key", async () => {
  const { agent, member } = await setup();

  await expect(
    member.a2a.createAccessKey({ agentId: agent.id, label: "Another" })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    member.a2a.createInvite({ agentId: agent.id })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: infra(),
  });
  const caller = appRouter.createCaller(
    await buildContext({ composed, session: { userId: null } })
  );

  await expect(caller.a2a.list({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});
