import { beforeEach, expect, test } from "bun:test";
import { apiKeys } from "@repo/db/schema/api-keys";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { API_KEY_PREFIX, createApiKeysService } from "./api-keys.ts";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService, type EventsService } from "./events.ts";
import { importRunTokenKey } from "./run-tokens.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";
import { createPrincipalResolver } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const MINUTE = 60 * 1000;

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const sameWorkspaceOtherUser: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherWorkspaceUser: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const machine: Principal = {
  kind: "machine",
  machineId: "m1",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let nowMs: number;
let clock: Clock;
let events: EventsService;
let service: ReturnType<typeof createApiKeysService>;

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

const advance = (ms: number) => {
  nowMs += ms;
};

const keyRow = (id: string) =>
  db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();

const apiKeyEvents = () =>
  events.query({ kind: "system" }, WORKSPACE, { types: ["api_key.created"] });

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = { now: () => new Date(nowMs), sleep: () => Promise.resolve() };
  seedWorkspace(WORKSPACE);
  seedWorkspace(OTHER_WORKSPACE);
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
  service = createApiKeysService({ clock, db, events });
});

test("create returns a hm_key_ secret, stores only its hash, and logs the event", async () => {
  const { key, secret } = await service.create(user, {
    access: "read",
    name: "  laptop  ",
  });

  expect(secret.startsWith(API_KEY_PREFIX)).toBe(true);
  expect(key.prefix).toBe(secret.slice(0, API_KEY_PREFIX.length + 4));
  expect(key).toEqual({
    access: "read",
    createdAt: START,
    id: key.id,
    lastUsedAt: null,
    name: "laptop",
    prefix: key.prefix,
    revokedAt: null,
  });
  expect(Object.keys(key)).not.toContain("keyHash");

  const row = keyRow(key.id);
  expect(row?.keyHash).toBe(await hashToken(secret));
  expect(row?.createdBy).toBe("u1");
  expect(row?.workspaceId).toBe(WORKSPACE);
  expect(JSON.stringify(row)).not.toContain(secret);

  const [event] = await apiKeyEvents();
  expect(event?.actor).toEqual({ id: "u1", kind: "user" });
  expect(event?.payload).toEqual({
    access: "read",
    keyId: key.id,
    name: "laptop",
  });
  expect(JSON.stringify(event)).not.toContain(secret);
});

test("a created secret resolves to its owner through the principal resolver", async () => {
  const { key, secret } = await service.create(user, {
    access: "write",
    name: "agent",
  });
  const { resolve } = createPrincipalResolver({
    db,
    isOrgMember: () => Promise.resolve(true),
    now: () => nowMs,
    runTokenKey: await importRunTokenKey(
      Buffer.from(new Uint8Array(32).fill(1)).toString("base64")
    ),
    verifyClerkOAuthToken: () => Promise.resolve(null),
  });

  expect(await resolve(`Bearer ${secret}`)).toEqual({
    apiKey: { access: "write", id: key.id, name: "agent" },
    kind: "user",
    userId: "u1",
    via: "api_key",
    workspaceId: WORKSPACE,
  });
});

test("a desk key resolves with the desk access", async () => {
  const { key, secret } = await service.create(user, {
    access: "desk",
    name: "flightdex",
  });
  const { resolve } = createPrincipalResolver({
    db,
    isOrgMember: () => Promise.resolve(true),
    now: () => nowMs,
    runTokenKey: await importRunTokenKey(
      Buffer.from(new Uint8Array(32).fill(1)).toString("base64")
    ),
    verifyClerkOAuthToken: () => Promise.resolve(null),
  });

  expect(await resolve(`Bearer ${secret}`)).toMatchObject({
    apiKey: { access: "desk", id: key.id },
    via: "api_key",
  });
});

test("only a signed-in user may create, list or revoke keys", async () => {
  const { key } = await service.create(user, { access: "read", name: "k" });
  const viaKey = { ...user, via: "api_key" as const };

  await expect(
    service.create(viaKey, { access: "read", name: "k" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(service.revoke(viaKey, key.id)).rejects.toBeInstanceOf(
    ForbiddenError
  );

  await expect(
    service.create(machine, { access: "read", name: "k" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(service.list(machine)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(service.revoke(machine, key.id)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("list returns only the caller's keys in their workspace, newest first, revoked included", async () => {
  const first = await service.create(user, { access: "read", name: "first" });
  advance(MINUTE);
  const second = await service.create(user, {
    access: "write",
    name: "second",
  });
  advance(MINUTE);
  await service.create(sameWorkspaceOtherUser, {
    access: "read",
    name: "theirs",
  });
  await service.create(otherWorkspaceUser, {
    access: "read",
    name: "elsewhere",
  });
  await service.revoke(user, first.key.id);

  const keys = await service.list(user);

  expect(keys.map((key) => key.name)).toEqual(["second", "first"]);
  expect(keys[0]?.id).toBe(second.key.id);
  expect(keys[1]?.revokedAt).toBe(new Date(nowMs).toISOString());
  expect(Object.keys(keys[0] ?? {})).not.toContain("keyHash");
});

test("revoke is scoped to the owner and the workspace", async () => {
  const { key } = await service.create(user, { access: "read", name: "k" });

  await expect(
    service.revoke(sameWorkspaceOtherUser, key.id)
  ).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    service.revoke(otherWorkspaceUser, key.id)
  ).rejects.toBeInstanceOf(ServiceError);
  expect(keyRow(key.id)?.revokedAt).toBeNull();

  const revoked = await service.revoke(user, key.id);
  expect(revoked.revokedAt).toBe(new Date(nowMs).toISOString());
});

test("revoking twice keeps the first timestamp", async () => {
  const { key } = await service.create(user, { access: "read", name: "k" });
  const first = await service.revoke(user, key.id);
  advance(MINUTE);
  const second = await service.revoke(user, key.id);

  expect(second.revokedAt).toBe(first.revokedAt);
  expect(keyRow(key.id)?.revokedAt).toBe(first.revokedAt);
});

test("touch writes at most once every five minutes", async () => {
  const { key } = await service.create(user, { access: "read", name: "k" });

  expect(await service.touch(key.id, WORKSPACE)).toBe(true);
  expect(keyRow(key.id)?.lastUsedAt).toBe(new Date(nowMs).toISOString());

  advance(4 * MINUTE + 59 * 1000);
  expect(await service.touch(key.id, WORKSPACE)).toBe(false);

  advance(1000);
  expect(await service.touch(key.id, WORKSPACE)).toBe(false);

  advance(1);
  expect(await service.touch(key.id, WORKSPACE)).toBe(true);
  expect(keyRow(key.id)?.lastUsedAt).toBe(new Date(nowMs).toISOString());
});

test("touch skips revoked keys and keys in another workspace", async () => {
  const { key } = await service.create(user, { access: "read", name: "k" });

  expect(await service.touch(key.id, OTHER_WORKSPACE)).toBe(false);
  expect(keyRow(key.id)?.lastUsedAt).toBeNull();

  await service.revoke(user, key.id);
  expect(await service.touch(key.id, WORKSPACE)).toBe(false);
  expect(keyRow(key.id)?.lastUsedAt).toBeNull();
});
