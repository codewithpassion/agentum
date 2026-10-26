import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentMailboxes } from "@repo/db/schema/mail";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { createEventsService } from "../events.ts";
import { SYSTEM_PRINCIPAL, type Principal } from "../workspaces.ts";
import { createMailService } from "./index.ts";
import { type EmailRoutingPort, type MailboxPort, RoutingNotConfiguredError } from "./types.ts";

const now = "2026-10-27T00:00:00.000Z";
const user: Principal = { kind: "user", userId: "u", workspaceId: "w", via: "session" };
let db: ReturnType<typeof migrated>;
let events: ReturnType<typeof createEventsService>;
let service: ReturnType<typeof createMailService>;
let rules: Map<string, string>;
let failure: Error | null;
let failAt: "find" | "create";
let creates: number;
const mailbox: MailboxPort = {
  discard: async () => {}, hold: async () => ({messageId: "m", threadId: "t"}),
  listThreads: async () => [], readAttachment: async () => null, readThread: async () => null,
  release: async () => ({messageId: "m", threadId: "t", rfcMessageId: "r"}),
  reply: async () => ({messageId: "m", threadId: "t", rfcMessageId: "r"}),
  send: async () => ({messageId: "m", threadId: "t", rfcMessageId: "r"}),
  storeInbound: async () => ({messageId: "m", threadId: "t", attachments: [], duplicate: false}),
};
const routing: EmailRoutingPort = {
  findRule: async (address) => { if (failure && failAt === "find") { throw failure; } const id = rules.get(address); return id ? {id} : null; },
  createRule: async (address) => { if (failure && failAt === "create") { throw failure; } creates += 1; rules.set(address, "rule"); return {id: "rule"}; },
  deleteRule: async (id) => { for (const [address, rule] of rules) { if (rule === id) { rules.delete(address); } } },
};
const options = () => ({db, atomic: sqliteAtomic(db), clock: {now: () => new Date(now), sleep: async () => {}}, events, mailbox, routing, domain: "example.com"});
const insertAgent = (id = "a", status = "active", emailLocal: string | null = id) => db.insert(agents).values({id, workspaceId: "w", createdBy: "u", createdAt: now, name: id, slug: id, instructions: "", model: "fake", runtime: "fake", runtimeConfig: "{}", status, emailLocal}).run();
beforeEach(() => {
  db = migrated(); rules = new Map(); failure = null; failAt = "create"; creates = 0;
  db.insert(workspaces).values({id: "w", clerkOrgId: "org", name: "W", createdAt: now}).run();
  events = createEventsService({db, blobs: {get: async () => null, put: async () => {}}});
  service = createMailService(options()); insertAgent();
});

test("provisions once with an enabled mail trigger and preserves a person's pause on retry", async () => {
  const row = await service.provision(user, "a");
  expect(row.status).toBe("active"); expect(row.address).toBe("a@example.com");
  const trigger = db.select().from(triggers).get();
  expect(trigger?.kind).toBe("mail"); expect(trigger?.disabledAt).toBeNull();
  await db.update(triggers).set({disabledAt: now});
  expect((await service.provision(user, "a")).id).toBe(row.id);
  expect(creates).toBe(1); expect(db.select().from(triggers).get()?.disabledAt).toBe(now);
});
test("an outside rule fails without replacing or deleting it", async () => {
  rules.set("a@example.com", "outside");
  expect(await service.provision(user, "a")).toMatchObject({status: "failed", lastError: "Address in use outside Harbourmaster", routingRuleId: null});
  expect(creates).toBe(0); await service.disable(user, "a"); expect(rules.get("a@example.com")).toBe("outside");
});
test("routing failure records the reason and retry reuses the mailbox and trigger", async () => {
  failure = new Error("Routing quota exceeded");
  const failed = await service.provision(user, "a");
  expect(failed).toMatchObject({status: "failed", lastError: failure.message});
  failure = null;
  expect(await service.provision(user, "a")).toMatchObject({id: failed.id, status: "active", lastError: null});
  expect(db.select().from(triggers).all()).toHaveLength(1);
});
for (const stage of ["find", "create"] as const) {
  test(`missing token at ${stage} stays pending and a later tick heals it and missing mailboxes`, async () => {
    failAt = stage; failure = new RoutingNotConfiguredError();
    expect(await service.provision(user, "a")).toMatchObject({status: "provisioning", lastError: "Provisioning pending: Cloudflare Email Routing is not configured yet"});
    insertAgent("b"); insertAgent("draft", "draft"); insertAgent("no-address", "active", null);
    failure = null; await service.provisionPending(SYSTEM_PRINCIPAL);
    expect((await service.get(user, "a"))?.status).toBe("active");
    expect((await service.get(user, "b"))?.status).toBe("active");
    expect(await service.get(user, "draft")).toBeNull(); expect(await service.get(user, "no-address")).toBeNull();
  });
}
test("disable deletes only the owned rule and keeps history; ticks leave it disabled", async () => {
  const row = await service.provision(user, "a");
  expect(await service.disable(user, "a")).toMatchObject({id: row.id, status: "disabled", routingRuleId: null});
  expect(rules.size).toBe(0); await service.disable(user, "a"); await service.provisionPending(SYSTEM_PRINCIPAL);
  expect((await service.get(user, "a"))?.status).toBe("disabled");
  expect(db.select().from(triggers).get()?.disabledAt).toBe(now);
});
test("event path provisions active agents only", async () => {
  insertAgent("draft", "draft");
  for (const agentId of ["a", "draft"]) {
    await events.append({actor: {kind: "user", id: "u"}, workspaceId: "w", agentId, type: "agent.address_reserved"});
  }
  expect((await service.get(user, "a"))?.status).toBe("active"); expect(await service.get(user, "draft")).toBeNull();
  await db.update(agents).set({status: "active"}).where(eq(agents.id, "draft"));
  await events.append({actor: {kind: "user", id: "u"}, workspaceId: "w", agentId: "draft", type: "agent.created"});
  expect((await service.get(user, "draft"))?.status).toBe("active");
});
test("people only, workspace isolation, and system-only sweep", async () => {
  const run: Principal = {kind: "run", workspaceId: "w", agentId: "a", runId: "r"};
  for (const principal of [run, {kind: "machine", workspaceId: "w", machineId: "m"} as const, {kind: "trigger", workspaceId: "w", agentId: "a", triggerId: "t"} as const, {...user, workspaceId: "other"}]) {
    await expect(service.get(principal, "a")).rejects.toThrow();
    await expect(service.provision(principal, "a")).rejects.toThrow();
    await expect(service.disable(principal, "a")).rejects.toThrow();
  }
  await expect(service.provisionPending(user)).rejects.toThrow(ForbiddenError);
  expect(db.select().from(agentMailboxes).all()).toHaveLength(0);
});
test("absent infra refuses clearly without a row", async () => {
  const unconfigured = createMailService({...options(), mailbox: undefined, routing: undefined, domain: undefined});
  await expect(unconfigured.provision(user, "a")).rejects.toThrow("Mail is not set up here");
  expect(db.select().from(agentMailboxes).all()).toHaveLength(0);
});
test("drafts and agents without addresses cannot be provisioned", async () => {
  insertAgent("draft", "draft"); insertAgent("empty", "active", null);
  await expect(service.provision(user, "draft")).rejects.toThrow();
  await expect(service.provision(user, "empty")).rejects.toThrow();
  expect(db.select().from(agentMailboxes).all()).toHaveLength(0);
});
