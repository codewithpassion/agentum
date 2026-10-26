import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { events as eventsTable } from "@repo/db/schema/events";
import { agentMailboxes } from "@repo/db/schema/mail";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { createEventsService } from "../events.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createMailService } from "./index.ts";
import {
  type EmailRoutingPort,
  type MailboxPort,
  RoutingNotConfiguredError,
} from "./types.ts";

const now = "2026-10-27T00:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u",
  via: "session",
  workspaceId: "w",
};
let db: ReturnType<typeof migrated>;
let events: ReturnType<typeof createEventsService>;
let service: ReturnType<typeof createMailService>;
let rules: Map<string, string>;
let failure: Error | null;
let failAt: "find" | "create";
let creates: number;
let managedRules: Set<string>;
const mailbox: MailboxPort = {
  discard: () => Promise.resolve(),
  hold: async () => ({ messageId: "m", threadId: "t" }),
  listThreads: async () => [],
  readAttachment: async () => null,
  readThread: async () => null,
  release: async () => ({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  reply: async () => ({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  send: async () => ({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  storeInbound: async () => ({
    attachments: [],
    duplicate: false,
    messageId: "m",
    threadId: "t",
  }),
};
const routing: EmailRoutingPort = {
  createRule: (address) => {
    if (failure && failAt === "create") {
      throw failure;
    }
    creates += 1;
    rules.set(address, "rule");
    return Promise.resolve({ id: "rule" });
  },
  deleteRule: (id) => {
    for (const [address, rule] of rules) {
      if (rule === id) {
        rules.delete(address);
      }
    }
    return Promise.resolve();
  },
  findRule: (address) => {
    if (failure && failAt === "find") {
      throw failure;
    }
    const id = rules.get(address);
    return Promise.resolve(
      id ? { id, managed: managedRules.has(address) } : null
    );
  },
};
const options = () => ({
  atomic: sqliteAtomic(db),
  clock: { now: () => new Date(now), sleep: () => Promise.resolve() },
  db,
  domain: "example.com",
  events,
  mailbox,
  routing,
});
const insertAgent = (
  id = "a",
  status = "active",
  emailLocal: string | null = id
) =>
  db
    .insert(agents)
    .values({
      createdAt: now,
      createdBy: "u",
      emailLocal,
      id,
      instructions: "",
      model: "fake",
      name: id,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status,
      workspaceId: "w",
    })
    .run();
beforeEach(() => {
  db = migrated();
  rules = new Map();
  managedRules = new Set();
  failure = null;
  failAt = "create";
  creates = 0;
  db.insert(workspaces)
    .values({
      clerkOrgId: "org",
      createdAt: now,
      id: "w",
      name: "W",
      timezone: "UTC",
    })
    .run();
  events = createEventsService({
    blobs: { get: async () => null, put: () => Promise.resolve() },
    db,
  });
  service = createMailService(options());
  insertAgent();
});

test("provisions once with an enabled mail trigger and preserves a person's pause on retry", async () => {
  const row = await service.provision(user, "a");
  expect(row.status).toBe("active");
  expect(row.address).toBe("a@example.com");
  const trigger = db.select().from(triggers).get();
  expect(trigger?.kind).toBe("mail");
  expect(trigger?.disabledAt).toBeNull();
  await db.update(triggers).set({ disabledAt: now });
  expect((await service.provision(user, "a")).id).toBe(row.id);
  expect(creates).toBe(1);
  expect(db.select().from(triggers).get()?.disabledAt).toBe(now);
});
test("an outside rule fails without replacing or deleting it", async () => {
  rules.set("a@example.com", "outside");
  expect(await service.provision(user, "a")).toMatchObject({
    lastError: "Address in use outside Harbourmaster",
    routingRuleId: null,
    status: "failed",
  });
  expect(creates).toBe(0);
  await service.disable(user, "a");
  expect(rules.get("a@example.com")).toBe("outside");
});
test("routing failure records the reason and retry reuses the mailbox and trigger", async () => {
  failure = new Error("Routing quota exceeded");
  const failed = await service.provision(user, "a");
  expect(failed).toMatchObject({
    lastError: failure.message,
    status: "failed",
  });
  failure = null;
  expect(await service.provision(user, "a")).toMatchObject({
    id: failed.id,
    lastError: null,
    status: "active",
  });
  expect(db.select().from(triggers).all()).toHaveLength(1);
});
for (const stage of ["find", "create"] as const) {
  test(`missing token at ${stage} stays pending and a later tick heals it and missing mailboxes`, async () => {
    failAt = stage;
    failure = new RoutingNotConfiguredError();
    expect(await service.provision(user, "a")).toMatchObject({
      lastError:
        "Provisioning pending: Cloudflare Email Routing is not configured yet",
      status: "provisioning",
    });
    insertAgent("b");
    insertAgent("draft", "draft");
    insertAgent("no-address", "active", null);
    failure = null;
    await service.provisionPending(SYSTEM_PRINCIPAL);
    expect((await service.get(user, "a"))?.status).toBe("active");
    expect((await service.get(user, "b"))?.status).toBe("active");
    expect(await service.get(user, "draft")).toBeNull();
    expect(await service.get(user, "no-address")).toBeNull();
  });
}
test("disable deletes only the owned rule and keeps history; ticks leave it disabled", async () => {
  const row = await service.provision(user, "a");
  expect(await service.disable(user, "a")).toMatchObject({
    id: row.id,
    routingRuleId: null,
    status: "disabled",
  });
  expect(rules.size).toBe(0);
  await service.disable(user, "a");
  await service.provisionPending(SYSTEM_PRINCIPAL);
  expect((await service.get(user, "a"))?.status).toBe("disabled");
  expect(db.select().from(triggers).get()?.disabledAt).toBe(now);
});
test("event path provisions active agents only", async () => {
  insertAgent("draft", "draft");
  for (const agentId of ["a", "draft"]) {
    // biome-ignore lint/performance/noAwaitInLoops: exercise ordered events
    await events.append({
      actor: { id: "u", kind: "user" },
      agentId,
      type: "agent.address_reserved",
      workspaceId: "w",
    });
  }
  expect((await service.get(user, "a"))?.status).toBe("active");
  expect(await service.get(user, "draft")).toBeNull();
  await db
    .update(agents)
    .set({ status: "active" })
    .where(eq(agents.id, "draft"));
  await events.append({
    actor: { id: "u", kind: "user" },
    agentId: "draft",
    type: "agent.created",
    workspaceId: "w",
  });
  expect((await service.get(user, "draft"))?.status).toBe("active");
});
test("people only, workspace isolation, and system-only sweep", async () => {
  const run: Principal = {
    agentId: "a",
    kind: "run",
    runId: "r",
    workspaceId: "w",
  };
  for (const principal of [
    run,
    { kind: "machine", machineId: "m", workspaceId: "w" } as const,
    {
      agentId: "a",
      kind: "trigger",
      triggerId: "t",
      workspaceId: "w",
    } as const,
    { ...user, workspaceId: "other" },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: check each denied principal
    await expect(service.get(principal, "a")).rejects.toThrow();
    await expect(service.provision(principal, "a")).rejects.toThrow();
    await expect(service.disable(principal, "a")).rejects.toThrow();
  }
  await expect(service.provisionPending(user)).rejects.toThrow(ForbiddenError);
  expect(db.select().from(agentMailboxes).all()).toHaveLength(0);
});
test("absent infra refuses clearly without a row", async () => {
  const unconfigured = createMailService({
    ...options(),
    domain: undefined,
    mailbox: undefined,
    routing: undefined,
  });
  await expect(unconfigured.provision(user, "a")).rejects.toThrow(
    "Mail is not set up here"
  );
  expect(db.select().from(agentMailboxes).all()).toHaveLength(0);
});
test("drafts and agents without addresses cannot be provisioned", async () => {
  insertAgent("draft", "draft");
  insertAgent("empty", "active", null);
  await expect(service.provision(user, "draft")).rejects.toThrow();
  await expect(service.provision(user, "empty")).rejects.toThrow();
  expect(db.select().from(agentMailboxes).all()).toHaveLength(0);
});

test("a new reserved address keeps the mailbox id and history while replacing our rule", async () => {
  const original = await service.provision(user, "a");
  await db
    .update(agents)
    .set({ emailLocal: "renamed" })
    .where(eq(agents.id, "a"));
  await events.append({
    actor: { id: "u", kind: "user" },
    agentId: "a",
    type: "agent.address_reserved",
    workspaceId: "w",
  });
  expect(await service.get(user, "a")).toMatchObject({
    address: "renamed@example.com",
    id: original.id,
    status: "active",
  });
  expect(rules.has("a@example.com")).toBe(false);
  expect(rules.has("renamed@example.com")).toBe(true);
  expect(db.select().from(triggers).all()).toHaveLength(1);
});

test("rule removal failure during an address change is recorded and can be retried", async () => {
  await service.provision(user, "a");
  await db
    .update(agents)
    .set({ emailLocal: "renamed" })
    .where(eq(agents.id, "a"));
  const failing = createMailService({
    ...options(),
    routing: {
      ...routing,
      deleteRule: () => Promise.reject(new Error("Routing unavailable")),
    },
  });
  expect(await failing.provision(user, "a")).toMatchObject({
    address: "a@example.com",
    lastError: "Routing unavailable",
    routingRuleId: "rule",
    status: "failed",
  });
  expect((await service.provision(user, "a")).status).toBe("active");
});

test("an explicit retry can re-enable a disabled mailbox without duplicating history", async () => {
  const row = await service.provision(user, "a");
  await service.disable(user, "a");
  expect(await service.provision(user, "a")).toMatchObject({
    id: row.id,
    status: "active",
  });
  expect(db.select().from(agentMailboxes).all()).toHaveLength(1);
  expect(db.select().from(triggers).all()).toHaveLength(1);
  expect(db.select().from(triggers).get()?.disabledAt).toBeNull();
});

test("provisioning logs mailbox.provisioned, a routing failure logs mailbox.failed, and a missing token logs nothing", async () => {
  const types = () =>
    db
      .select()
      .from(eventsTable)
      .all()
      .map((event) => event.type)
      .filter((type) => type.startsWith("mailbox."));
  failure = new RoutingNotConfiguredError();
  await service.provision(user, "a");
  expect(types()).toEqual([]);
  failure = new Error("boom");
  await service.provision(user, "a");
  expect(types()).toEqual(["mailbox.failed"]);
  failure = null;
  await service.provision(user, "a");
  expect(types()).toEqual(["mailbox.failed", "mailbox.provisioned"]);
});

test("a deployment-wide mailbox address conflict uses the V3 conflict error and writes no trigger", async () => {
  insertAgent("other");
  await db.insert(agentMailboxes).values({
    address: "a@example.com",
    agentId: "other",
    createdAt: now,
    id: "existing",
    status: "disabled",
    workspaceId: "w",
  });
  await expect(service.provision(user, "a")).rejects.toMatchObject({
    code: "conflict",
    message: "That address is taken",
  });
  expect(db.select().from(triggers).all()).toHaveLength(0);
  expect(db.select().from(agentMailboxes).all()).toHaveLength(1);
});

test("a retry adopts our own rule whose id never reached the row", async () => {
  rules.set("a@example.com", "orphan");
  managedRules.add("a@example.com");
  expect(await service.provision(user, "a")).toMatchObject({
    routingRuleId: "orphan",
    status: "active",
  });
  expect(creates).toBe(0);
});

test("one refused agent does not stop the sweep", async () => {
  insertAgent("b");
  insertAgent("c");
  await db.insert(agentMailboxes).values({
    address: "b@example.com",
    agentId: "a",
    createdAt: now,
    id: "stale",
    status: "disabled",
    workspaceId: "w",
  });
  const logged = console.error;
  console.error = () => undefined;
  try {
    await service.provisionPending(SYSTEM_PRINCIPAL);
  } finally {
    console.error = logged;
  }
  expect((await service.get(user, "c"))?.status).toBe("active");
});
