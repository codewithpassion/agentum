import { beforeEach, describe, expect, test } from "bun:test";
import { oauthClients } from "@repo/db/schema/oauth-clients";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import {
  createOAuthClientsService,
  MAX_OAUTH_CLIENT_NAME_LENGTH,
  type OAuthClientsService,
  oauthClientSetAccessInputSchema,
  sanitizeOAuthClientName,
} from "./oauth-clients.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const START = "2026-10-16T10:00:00.000Z";
const MINUTE = 60 * 1000;
const CLIENT = "client_a";
const OTHER_CLIENT = "client_b";

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const otherWorkspaceUser: Principal = {
  kind: "user",
  userId: "u2",
  via: "session",
  workspaceId: OTHER_WORKSPACE,
};
const apiKeyPrincipal: Principal = {
  apiKey: { access: "write", id: "k1" },
  kind: "user",
  userId: "u1",
  via: "api_key",
  workspaceId: WORKSPACE,
};
const runPrincipal: Principal = {
  agentId: "a1",
  kind: "run",
  runId: "r1",
  workspaceId: WORKSPACE,
};

let db: ReturnType<typeof migrated>;
let nowMs: number;
let clock: Clock;
let service: OAuthClientsService;

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

const now = () => new Date(nowMs).toISOString();

const row = (clientId: string) =>
  db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .get();

/** A first request from `userId` for `clientId`, in a workspace `home`. */
const firstSeen = (
  clientId: string,
  home: string | null = WORKSPACE,
  name?: () => Promise<string | null>
) =>
  service.resolve({
    clientId,
    homeWorkspaceId: () => Promise.resolve(home),
    name,
    userId: "u1",
  });

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = { now: () => new Date(nowMs), sleep: () => Promise.resolve() };
  seedWorkspace(WORKSPACE);
  seedWorkspace(OTHER_WORKSPACE);
  service = createOAuthClientsService({
    clock,
    db,
    nameLookupFailures: new Map(),
  });
});

test("an unknown client is recorded pending with a sanitized name, and the name is looked up once", async () => {
  const name = () => Promise.resolve("  Cool‮   App  ");
  let homeCalls = 0;
  const homeWorkspaceId = () => {
    homeCalls += 1;
    return Promise.resolve(WORKSPACE);
  };
  let nameCalls = 0;
  const lookup = () => {
    nameCalls += 1;
    return name();
  };

  const first = await service.resolve({
    clientId: CLIENT,
    homeWorkspaceId,
    name: lookup,
    userId: "u1",
  });

  expect(first).toEqual({ name: "Cool App", status: "pending" });
  expect(row(CLIENT)).toMatchObject({
    access: null,
    clientId: CLIENT,
    createdAt: now(),
    firstSeenBy: "u1",
    name: "Cool App",
    revokedAt: null,
    workspaceId: WORKSPACE,
  });
  expect(homeCalls).toBe(1);
  expect(nameCalls).toBe(1);

  advance(MINUTE);
  const second = await service.resolve({
    clientId: CLIENT,
    homeWorkspaceId,
    name: lookup,
    userId: "u2",
  });

  expect(second).toEqual({ name: "Cool App", status: "pending" });
  expect(homeCalls).toBe(1);
  expect(nameCalls).toBe(1);
});

test("an unknown client with no home workspace is answered no_workspace and records nothing", async () => {
  const result = await firstSeen(CLIENT, null);

  expect(result).toEqual({ status: "no_workspace" });
  expect(row(CLIENT)).toBeUndefined();
});

test("a client whose name lookup throws is recorded with a null name", async () => {
  const result = await firstSeen(CLIENT, WORKSPACE, () =>
    Promise.reject(new Error("clerk down"))
  );

  expect(result).toEqual({ name: null, status: "pending" });
  expect(row(CLIENT)?.name).toBeNull();
});

test("a pending client stored without a name gets it filled on the next resolve", async () => {
  await firstSeen(CLIENT);
  let nameCalls = 0;
  const lookup = () => {
    nameCalls += 1;
    return Promise.resolve("  Late‮   Name  ");
  };

  const filled = await service.resolve({
    clientId: CLIENT,
    homeWorkspaceId: () => Promise.resolve(WORKSPACE),
    name: lookup,
    userId: "u1",
  });

  expect(filled).toEqual({ name: "Late Name", status: "pending" });
  expect(row(CLIENT)?.name).toBe("Late Name");
  expect(nameCalls).toBe(1);

  await service.resolve({
    clientId: CLIENT,
    homeWorkspaceId: () => Promise.resolve(WORKSPACE),
    name: lookup,
    userId: "u1",
  });
  expect(nameCalls).toBe(1);
});

test("an approved client stored without a name gets it filled, and is still approved", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });

  const result = await firstSeen(CLIENT, WORKSPACE, () =>
    Promise.resolve("Approved App")
  );

  expect(result).toEqual({
    access: "read",
    status: "approved",
    workspaceId: WORKSPACE,
  });
  expect(row(CLIENT)?.name).toBe("Approved App");
});

test("a revoked client stored without a name gets it filled, and is still revoked", async () => {
  await firstSeen(CLIENT);
  await service.revoke(user, { clientId: CLIENT });

  const result = await firstSeen(CLIENT, WORKSPACE, () =>
    Promise.resolve("Denied App")
  );

  expect(result).toEqual({ name: "Denied App", status: "revoked" });
  expect(row(CLIENT)?.name).toBe("Denied App");
});

test("a stored name is kept and never looked up again", async () => {
  await firstSeen(CLIENT, WORKSPACE, () => Promise.resolve("First Name"));
  let nameCalls = 0;

  const result = await firstSeen(CLIENT, WORKSPACE, () => {
    nameCalls += 1;
    return Promise.resolve("Other Name");
  });

  expect(result).toEqual({ name: "First Name", status: "pending" });
  expect(row(CLIENT)?.name).toBe("First Name");
  expect(nameCalls).toBe(0);
});

test("two concurrent resolves of a nameless client store one name and agree on it", async () => {
  await firstSeen(CLIENT);

  const [a, b] = await Promise.all([
    firstSeen(CLIENT, WORKSPACE, () => Promise.resolve("Alpha")),
    firstSeen(CLIENT, WORKSPACE, () => Promise.resolve("Beta")),
  ]);

  const stored = row(CLIENT)?.name ?? null;
  expect(["Alpha", "Beta"]).toContain(stored ?? "");
  expect(a).toEqual({ name: stored, status: "pending" });
  expect(b).toEqual({ name: stored, status: "pending" });
});

test("a nameless client stays nameless when the lookup throws or returns null", async () => {
  await firstSeen(CLIENT);

  const thrown = await firstSeen(CLIENT, WORKSPACE, () =>
    Promise.reject(new Error("clerk down"))
  );
  const missing = await firstSeen(CLIENT, WORKSPACE, () =>
    Promise.resolve(null)
  );

  expect(thrown).toEqual({ name: null, status: "pending" });
  expect(missing).toEqual({ name: null, status: "pending" });
  expect(row(CLIENT)?.name).toBeNull();
});

test("approving a client makes resolve answer approved with its access and workspace", async () => {
  await firstSeen(CLIENT);

  const summary = await service.setAccess(user, {
    access: "read",
    clientId: CLIENT,
  });

  expect(summary).toEqual({
    access: "read",
    approvedAt: now(),
    clientId: CLIENT,
    firstSeenAt: now(),
    lastUsedAt: null,
    name: null,
    revokedAt: null,
    status: "approved",
  });
  expect(await firstSeen(CLIENT)).toEqual({
    access: "read",
    status: "approved",
    workspaceId: WORKSPACE,
  });
});

test("changing the access of an approved client takes effect on the next resolve", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });
  advance(MINUTE);

  const changed = await service.setAccess(user, {
    access: "write",
    clientId: CLIENT,
  });

  expect(changed.access).toBe("write");
  expect(changed.approvedAt).toBe(now());
  expect(await firstSeen(CLIENT)).toMatchObject({
    access: "write",
    status: "approved",
  });
});

test("a revoked client resolves as revoked", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "write", clientId: CLIENT });

  const revoked = await service.revoke(user, { clientId: CLIENT });

  expect(revoked).toMatchObject({
    access: null,
    revokedAt: now(),
    status: "revoked",
  });
  expect(await firstSeen(CLIENT)).toEqual({ name: null, status: "revoked" });
});

test("a revoked client can be approved again", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });
  await service.revoke(user, { clientId: CLIENT });
  advance(MINUTE);

  const reapproved = await service.setAccess(user, {
    access: "write",
    clientId: CLIENT,
  });

  expect(reapproved).toMatchObject({
    access: "write",
    approvedAt: now(),
    revokedAt: null,
    status: "approved",
  });
  expect(await firstSeen(CLIENT)).toEqual({
    access: "write",
    status: "approved",
    workspaceId: WORKSPACE,
  });
});

test("revoking twice keeps the first timestamp", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });
  const first = await service.revoke(user, { clientId: CLIENT });
  advance(MINUTE);

  const second = await service.revoke(user, { clientId: CLIENT });

  expect(second.revokedAt).toBe(first.revokedAt);
  expect(row(CLIENT)?.revokedAt).toBe(first.revokedAt);
});

test("revoking a pending client denies it", async () => {
  await firstSeen(CLIENT);

  const denied = await service.revoke(user, { clientId: CLIENT });

  expect(denied.status).toBe("revoked");
  expect(await firstSeen(CLIENT)).toEqual({ name: null, status: "revoked" });
});

test("setAccess and revoke on a client of another workspace are not_found", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });

  await expect(
    service.setAccess(otherWorkspaceUser, { access: "write", clientId: CLIENT })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.revoke(otherWorkspaceUser, { clientId: CLIENT })
  ).rejects.toBeInstanceOf(ServiceError);
  await expect(
    service.revoke(otherWorkspaceUser, { clientId: CLIENT })
  ).rejects.toMatchObject({ code: "not_found" });

  expect(row(CLIENT)).toMatchObject({ access: "read", revokedAt: null });
});

test("setAccess and revoke on an unknown client are not_found", async () => {
  await expect(
    service.setAccess(user, { access: "read", clientId: "nope" })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    service.revoke(user, { clientId: "nope" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("list shows only the caller's workspace, pending clients first", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });
  advance(MINUTE);
  await firstSeen(OTHER_CLIENT);
  advance(MINUTE);
  await firstSeen("theirs", OTHER_WORKSPACE);

  const clients = await service.list(user);

  expect(clients.map((client) => client.clientId)).toEqual([
    OTHER_CLIENT,
    CLIENT,
  ]);
  expect(clients.map((client) => client.status)).toEqual([
    "pending",
    "approved",
  ]);
  expect(await service.list(otherWorkspaceUser)).toEqual([
    expect.objectContaining({ clientId: "theirs", status: "pending" }),
  ]);
});

test("list orders by most recently used after pending, then newest first", async () => {
  await firstSeen("old_used");
  await firstSeen("new_unused");
  advance(MINUTE);
  await firstSeen("new_used");
  await service.setAccess(user, { access: "read", clientId: "old_used" });
  await service.setAccess(user, { access: "read", clientId: "new_unused" });
  await service.setAccess(user, { access: "read", clientId: "new_used" });
  await service.touch("old_used", WORKSPACE);
  advance(10 * MINUTE);
  await service.touch("new_used", WORKSPACE);

  const clients = await service.list(user);

  expect(clients.map((client) => client.clientId)).toEqual([
    "new_used",
    "old_used",
    "new_unused",
  ]);
});

test("only a signed-in user may list, approve or revoke clients", async () => {
  await firstSeen(CLIENT);

  const refusals = (principal: Principal) => [
    expect(service.list(principal)).rejects.toBeInstanceOf(ForbiddenError),
    expect(
      service.setAccess(principal, { access: "read", clientId: CLIENT })
    ).rejects.toBeInstanceOf(ForbiddenError),
    expect(
      service.revoke(principal, { clientId: CLIENT })
    ).rejects.toBeInstanceOf(ForbiddenError),
  ];
  await Promise.all([...refusals(apiKeyPrincipal), ...refusals(runPrincipal)]);
  expect(row(CLIENT)).toMatchObject({ access: null, revokedAt: null });
});

test("setAccess and revoke reject inputs outside their schema", async () => {
  await firstSeen(CLIENT);

  await expect(
    service.setAccess(user, {
      access: "admin",
      clientId: CLIENT,
    } as unknown as Parameters<OAuthClientsService["setAccess"]>[1])
  ).rejects.toThrow();
  await expect(service.revoke(user, { clientId: "" })).rejects.toThrow();
  expect(row(CLIENT)).toMatchObject({ access: null, revokedAt: null });
});

test("touch writes at most once every five minutes, and only for approved clients", async () => {
  await firstSeen(CLIENT);
  await service.setAccess(user, { access: "read", clientId: CLIENT });

  expect(await service.touch(CLIENT, WORKSPACE)).toBe(true);
  expect(row(CLIENT)?.lastUsedAt).toBe(now());

  advance(4 * MINUTE + 59 * 1000);
  expect(await service.touch(CLIENT, WORKSPACE)).toBe(false);

  advance(1000);
  expect(await service.touch(CLIENT, WORKSPACE)).toBe(false);

  advance(1);
  expect(await service.touch(CLIENT, WORKSPACE)).toBe(true);
  expect(row(CLIENT)?.lastUsedAt).toBe(now());
});

test("touch never writes for a pending, revoked or other-workspace client", async () => {
  await firstSeen(CLIENT);
  expect(await service.touch(CLIENT, WORKSPACE)).toBe(false);
  expect(row(CLIENT)?.lastUsedAt).toBeNull();

  await service.setAccess(user, { access: "read", clientId: CLIENT });
  expect(await service.touch(CLIENT, OTHER_WORKSPACE)).toBe(false);
  expect(row(CLIENT)?.lastUsedAt).toBeNull();

  await service.revoke(user, { clientId: CLIENT });
  expect(await service.touch(CLIENT, WORKSPACE)).toBe(false);
  expect(row(CLIENT)?.lastUsedAt).toBeNull();
});

describe("sanitizeOAuthClientName", () => {
  test("strips control and format characters", () => {
    expect(sanitizeOAuthClientName("a\u0000b​c‮d\u007Fe")).toBe("abcde");
  });

  test("collapses whitespace and trims it", () => {
    expect(sanitizeOAuthClientName("  one \n\t two ​ three  ")).toBe(
      "one two three"
    );
  });

  test("caps the length in code points", () => {
    const long = "😀".repeat(MAX_OAUTH_CLIENT_NAME_LENGTH + 5);
    const cleaned = sanitizeOAuthClientName(long);

    expect(Array.from(cleaned ?? "")).toHaveLength(
      MAX_OAUTH_CLIENT_NAME_LENGTH
    );
  });

  test("empty, blank or missing input is null", () => {
    expect(sanitizeOAuthClientName("")).toBeNull();
    expect(sanitizeOAuthClientName(" ​ \n ")).toBeNull();
    expect(sanitizeOAuthClientName(null)).toBeNull();
    expect(sanitizeOAuthClientName(undefined)).toBeNull();
  });
});

test("a failed name lookup for a nameless client is retried after five minutes, across requests", async () => {
  const nameLookupFailures = new Map<string, number>();
  // The app builds the service per request, so each call gets its own.
  const request = (name: () => Promise<string | null>) =>
    createOAuthClientsService({ clock, db, nameLookupFailures }).resolve({
      clientId: CLIENT,
      homeWorkspaceId: () => Promise.resolve(WORKSPACE),
      name,
      userId: "user_1",
    });
  await request(() => Promise.resolve(null));
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.resolve(null);
  };

  await request(failing);
  await request(failing);
  expect(calls).toBe(1);

  nowMs += 5 * 60 * 1000;
  await request(failing);
  expect(calls).toBe(2);

  const throttled = await request(() => Promise.resolve("Late Name"));
  expect(throttled).toEqual({ name: null, status: "pending" });

  nowMs += 5 * 60 * 1000;
  const retried = await request(() => Promise.resolve("Late Name"));
  expect(retried).toEqual({ name: "Late Name", status: "pending" });
});

test("a connected app cannot be given the desk access", () => {
  expect(
    oauthClientSetAccessInputSchema.safeParse({
      access: "desk",
      clientId: CLIENT,
    }).success
  ).toBe(false);
});
