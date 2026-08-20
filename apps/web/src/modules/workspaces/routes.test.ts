import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { createDb, type Db } from "#/db/client";
import { findClerkIdLeaksInBody } from "./clerk-id-leaks";

/**
 * The workspace API end to end: the same two mounts `server.ts` makes, over the
 * shipped migrations in an in-memory database, with Clerk faked.
 *
 * Two things are stubbed, both at the package boundary so the routers under
 * test are the ones that ship: the Clerk session (`@clerk/hono`, which
 * `requireAuth` reads) and the Clerk directory (`@clerk/backend`, which
 * member-by-email goes through). Nothing here touches the network.
 */

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

interface FakeClerkUser {
  emailAddresses: { emailAddress: string }[];
  firstName: string | null;
  id: string;
  imageUrl: string;
  lastName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}

/** Clerk ids look like this, which is exactly what must never be serialized. */
const OWNER_ID = "user_2aOwnerAAAAAAAAAAAAAAAAAA";
const MEMBER_ID = "user_2bMemberBBBBBBBBBBBBBBB";
const OUTSIDER_ID = "user_2cOutsiderCCCCCCCCCCCC";
const NEWCOMER_ID = "user_2dNewcomerDDDDDDDDDDDD";

const clerkUser = (id: string, email: string, name: string): FakeClerkUser => ({
  emailAddresses: [{ emailAddress: email }],
  firstName: name.split(" ")[0] ?? null,
  id,
  // Deliberately free of the Clerk id: the serialization test greps for it.
  imageUrl: `https://images.example.com/${email.split("@")[0]}.png`,
  lastName: name.split(" ")[1] ?? null,
  primaryEmailAddress: { emailAddress: email },
});

const directory = new Map<string, FakeClerkUser>([
  [OWNER_ID, clerkUser(OWNER_ID, "ada@example.com", "Ada Lovelace")],
  [MEMBER_ID, clerkUser(MEMBER_ID, "grace@example.com", "Grace Hopper")],
  [OUTSIDER_ID, clerkUser(OUTSIDER_ID, "alan@example.com", "Alan Turing")],
  [NEWCOMER_ID, clerkUser(NEWCOMER_ID, "katherine@example.com", "Katherine J")],
]);

mock.module("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUser: (id: string) => {
        const user = directory.get(id);
        return user
          ? Promise.resolve(user)
          : Promise.reject(new Error("Not Found"));
      },
      getUserList: ({ emailAddress }: { emailAddress: string[] }) => {
        const [wanted] = emailAddress;
        const data = [...directory.values()].filter(
          (user) => user.primaryEmailAddress?.emailAddress === wanted
        );
        return Promise.resolve({ data });
      },
    },
  }),
}));

const { workspaceScopedRoutes, workspacesRoutes } = await import("./routes");
const { addMember, createWorkspace, getWorkspaceBySlug, listMembers } =
  await import("./service");

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/**
 * The three statement methods drizzle's D1 driver calls, over `bun:sqlite` -
 * the routes build their own `createDb(c.env.DB)`, so the test has to hand them
 * something D1-shaped rather than a drizzle instance.
 */
const createTestD1 = (): D1Database => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

/**
 * What Phase 3 will do to every resource router, pinned here: mounting onto
 * `workspaceScopedRoutes` is all it takes to inherit both gates and read the
 * workspace off the context. It goes on before the mount below, since that is
 * the moment Hono copies the routes - the same order `server.ts` uses.
 */
const probeRoutes = new Hono<ApiEnv>();
probeRoutes.get("/", (c) => c.json({ scopedTo: c.get("workspace").slug }));
workspaceScopedRoutes.route("/probe", probeRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/workspaces", workspacesRoutes);
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let d1: D1Database;
let db: Db;
let env: Env;

const request = (
  path: string,
  init: { as?: string | null; body?: unknown; method?: string } = {}
) => {
  signedInAs = init.as === undefined ? OWNER_ID : init.as;
  return app.request(
    path,
    {
      ...(init.body === undefined
        ? {}
        : {
            body: JSON.stringify(init.body),
            headers: { "content-type": "application/json" },
          }),
      method: init.method ?? "GET",
    },
    env
  );
};

/** `Response.json()` is typed as nothing in particular; assertions need a value. */
const bodyOf = (response: Response): Promise<unknown> => response.json();

const snapshotOf = (clerkUserId: string) => {
  const user = directory.get(clerkUserId);
  if (!user) {
    throw new Error(`No fake Clerk user ${clerkUserId}.`);
  }
  return {
    clerkUserId,
    email: user.primaryEmailAddress?.emailAddress ?? "",
    imageUrl: user.imageUrl,
    name: `${user.firstName} ${user.lastName}`,
  };
};

const seedWorkspaceId = async (): Promise<string> => {
  const workspace = await getWorkspaceBySlug(db, "acme-rockets");
  if (!workspace) {
    throw new Error("The seeded workspace is gone.");
  }
  return workspace.id;
};

/** Acme: Ada owns it, Grace is a member. Globex: Alan owns it, alone. */
const seed = async () => {
  const { workspace } = await createWorkspace(db, {
    name: "Acme Rockets",
    owner: snapshotOf(OWNER_ID),
  });
  await addMember(db, workspace.id, {
    ...snapshotOf(MEMBER_ID),
    role: "member",
  });
  await createWorkspace(db, {
    name: "Globex",
    owner: snapshotOf(OUTSIDER_ID),
  });
  return workspace;
};

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  env = { CLERK_SECRET_KEY: "sk_test_fake", DB: d1 } as unknown as Env;
  await seed();
});

describe("requireWorkspace", () => {
  test("answers 404 for a slug that does not exist", async () => {
    const response = await request("/api/w/nope");
    expect(response.status).toBe(404);
  });

  test("answers the same 404 to a member of another workspace", async () => {
    const missing = await request("/api/w/nope", { as: OUTSIDER_ID });
    const forbidden = await request("/api/w/acme-rockets", { as: OUTSIDER_ID });

    expect(forbidden.status).toBe(404);
    expect(await bodyOf(forbidden)).toEqual(await bodyOf(missing));
  });

  test("answers 401 when nobody is signed in", async () => {
    const response = await request("/api/w/acme-rockets", { as: null });
    expect(response.status).toBe(401);
  });

  test("puts the workspace and the caller's membership on the context", async () => {
    const response = await request("/api/w/acme-rockets", { as: MEMBER_ID });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      membership: { memberId: string; role: string };
      workspace: { name: string; slug: string };
    };
    expect(body.workspace.name).toBe("Acme Rockets");
    expect(body.workspace.slug).toBe("acme-rockets");
    expect(body.membership.role).toBe("member");

    const members = await listMembers(db, await seedWorkspaceId());
    expect(members.some((row) => row.id === body.membership.memberId)).toBe(
      true
    );
  });

  test("gates a router mounted onto it the way Phase 3 will", async () => {
    const mine = await request("/api/w/acme-rockets/probe", { as: MEMBER_ID });
    expect(await bodyOf(mine)).toEqual({ scopedTo: "acme-rockets" });

    const theirs = await request("/api/w/globex/probe", { as: MEMBER_ID });
    expect(theirs.status).toBe(404);

    const anonymous = await request("/api/w/acme-rockets/probe", { as: null });
    expect(anonymous.status).toBe(401);
  });
});

describe("requireOwner", () => {
  test("blocks a plain member from every owner-only route", async () => {
    const attempts = await Promise.all([
      request("/api/w/acme-rockets", {
        as: MEMBER_ID,
        body: { name: "Renamed" },
        method: "PATCH",
      }),
      request("/api/w/acme-rockets", { as: MEMBER_ID, method: "DELETE" }),
      request("/api/w/acme-rockets/members", {
        as: MEMBER_ID,
        body: { email: "katherine@example.com" },
        method: "POST",
      }),
      request(
        "/api/w/acme-rockets/members/search?email=katherine@example.com",
        {
          as: MEMBER_ID,
        }
      ),
    ]);

    expect(attempts.map((response) => response.status)).toEqual([
      403, 403, 403, 403,
    ]);
  });

  test("lets an owner rename the workspace, keeping the slug", async () => {
    const response = await request("/api/w/acme-rockets", {
      body: { name: "Acme Interstellar" },
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({
      workspace: { name: "Acme Interstellar", slug: "acme-rockets" },
    });
  });
});

describe("/api/workspaces", () => {
  test("lists only the workspaces the caller belongs to", async () => {
    const mine = (await (await request("/api/workspaces")).json()) as {
      workspaces: {
        membership: { role: string };
        workspace: { slug: string };
      }[];
    };

    expect(mine.workspaces.map((row) => row.workspace.slug)).toEqual([
      "acme-rockets",
    ]);
    expect(mine.workspaces.map((row) => row.membership.role)).toEqual([
      "owner",
    ]);
  });

  test("creates a workspace whose creator is its owner", async () => {
    const response = await request("/api/workspaces", {
      as: NEWCOMER_ID,
      body: { name: "Initech" },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toMatchObject({
      membership: { role: "owner" },
      workspace: { name: "Initech", slug: "initech" },
    });

    const members = await request("/api/w/initech/members", {
      as: NEWCOMER_ID,
    });
    expect(await bodyOf(members)).toEqual({
      members: [
        {
          email: "katherine@example.com",
          id: expect.any(String),
          imageUrl: "https://images.example.com/katherine.png",
          name: "Katherine J",
          role: "owner",
        },
      ],
    });
  });

  test("refuses to seat an owner it cannot identify", async () => {
    // No Clerk profile means no email, and a member list cannot render an
    // owner with no email - so nothing is created at all.
    const response = await request("/api/workspaces", {
      as: "user_2eGhostEEEEEEEEEEEEEEEEEE",
      body: { name: "Ghost Town" },
      method: "POST",
    });

    expect(response.status).toBe(502);
    expect(await getWorkspaceBySlug(db, "ghost-town")).toBeUndefined();
  });

  test("suffixes the slug when the derived one is taken", async () => {
    const response = await request("/api/workspaces", {
      as: NEWCOMER_ID,
      body: { name: "Acme Rockets" },
      method: "POST",
    });

    const body = (await response.json()) as { workspace: { slug: string } };
    expect(body.workspace.slug).toStartWith("acme-rockets-");
    expect(body.workspace.slug).not.toBe("acme-rockets");
  });

  test("deletes a workspace with its memberships, members cannot", async () => {
    const workspaceId = await seedWorkspaceId();
    const refused = await request("/api/w/acme-rockets", {
      as: MEMBER_ID,
      method: "DELETE",
    });
    expect(refused.status).toBe(403);

    const deleted = await request("/api/w/acme-rockets", { method: "DELETE" });
    expect(deleted.status).toBe(204);

    expect((await request("/api/w/acme-rockets")).status).toBe(404);
    // The one real foreign key into `workspaces`: the memberships go too.
    expect(await listMembers(db, workspaceId)).toEqual([]);
  });
});

describe("/api/w/:slug/members", () => {
  test("adds a member by email", async () => {
    const response = await request("/api/w/acme-rockets/members", {
      body: { email: "Katherine@Example.com" },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toEqual({
      member: {
        email: "katherine@example.com",
        id: expect.any(String),
        imageUrl: "https://images.example.com/katherine.png",
        name: "Katherine J",
        role: "member",
      },
    });

    const listed = (await (
      await request("/api/w/acme-rockets/members")
    ).json()) as { members: { email: string }[] };
    expect(listed.members.map((member) => member.email)).toEqual([
      "ada@example.com",
      "grace@example.com",
      "katherine@example.com",
    ]);
  });

  test("answers 409 when the email is already a member", async () => {
    const response = await request("/api/w/acme-rockets/members", {
      body: { email: "grace@example.com" },
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({
      error: "grace@example.com is already a member.",
    });
  });

  test("answers 404 when no Clerk account has that email", async () => {
    const response = await request("/api/w/acme-rockets/members", {
      body: { email: "nobody@example.com" },
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("nobody@example.com"),
    });
  });

  test("searches an email without handing back an id", async () => {
    const found = await request(
      "/api/w/acme-rockets/members/search?email=Katherine@example.com"
    );
    expect(await bodyOf(found)).toEqual({
      email: "katherine@example.com",
      exists: true,
      imageUrl: "https://images.example.com/katherine.png",
      name: "Katherine J",
    });

    const missing = await request(
      "/api/w/acme-rockets/members/search?email=nobody@example.com"
    );
    expect(await bodyOf(missing)).toEqual({
      email: "nobody@example.com",
      exists: false,
      imageUrl: null,
      name: null,
    });
  });

  test("refuses to demote or remove the last owner", async () => {
    const members = await listMembers(db, await seedWorkspaceId());
    const owner = members.find((member) => member.role === "owner");
    const path = `/api/w/acme-rockets/members/${owner?.id}`;

    const demoted = await request(path, {
      body: { role: "member" },
      method: "PATCH",
    });
    const removed = await request(path, { method: "DELETE" });

    expect(demoted.status).toBe(409);
    expect(removed.status).toBe(409);
    expect((await demoted.json()) as { error: string }).toEqual({
      error: "A workspace has to keep at least one owner.",
    });
  });

  test("promotes a member, which then frees the other owner", async () => {
    const members = await listMembers(db, await seedWorkspaceId());
    const owner = members.find((row) => row.role === "owner");
    const member = members.find((row) => row.role === "member");

    const promoted = await request(
      `/api/w/acme-rockets/members/${member?.id}`,
      { body: { role: "owner" }, method: "PATCH" }
    );
    expect(promoted.status).toBe(200);
    expect(await bodyOf(promoted)).toMatchObject({
      member: { email: "grace@example.com", role: "owner" },
    });

    const removed = await request(`/api/w/acme-rockets/members/${owner?.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
  });

  test("answers 404 for a member id from another workspace", async () => {
    const globex = await getWorkspaceBySlug(db, "globex");
    const [outsider] = await listMembers(db, globex?.id ?? "");

    const response = await request(
      `/api/w/acme-rockets/members/${outsider?.id}`,
      { method: "DELETE" }
    );
    expect(response.status).toBe(404);
  });

  test("fills in an empty-email snapshot from Clerk on list", async () => {
    // What migration 0012 leaves behind: a membership with no email yet.
    const workspaceId = await seedWorkspaceId();
    await addMember(db, workspaceId, {
      clerkUserId: NEWCOMER_ID,
      email: "",
      imageUrl: null,
      name: null,
      role: "member",
    });

    const listed = (await (
      await request("/api/w/acme-rockets/members")
    ).json()) as { members: { email: string; name: string | null }[] };

    expect(
      listed.members.find((member) => member.name === "Katherine J")?.email
    ).toBe("katherine@example.com");
    // And it is written back, so the next list needs no Clerk call.
    const stored = await listMembers(db, workspaceId);
    expect(stored.every((member) => member.email !== "")).toBe(true);
  });
});

describe("serialization", () => {
  test("no response body carries a Clerk user id", async () => {
    const workspaceId = await seedWorkspaceId();
    const members = await listMembers(db, workspaceId);
    const member = members.find((row) => row.role === "member");

    const bodies = await Promise.all(
      [
        await request("/api/workspaces"),
        await request("/api/workspaces", {
          as: NEWCOMER_ID,
          body: { name: "Initech" },
          method: "POST",
        }),
        await request("/api/w/acme-rockets"),
        await request("/api/w/acme-rockets", {
          body: { name: "Acme Interstellar" },
          method: "PATCH",
        }),
        await request("/api/w/acme-rockets/members"),
        await request("/api/w/acme-rockets/members", {
          body: { email: "katherine@example.com" },
          method: "POST",
        }),
        await request(
          "/api/w/acme-rockets/members/search?email=katherine@example.com"
        ),
        await request(`/api/w/acme-rockets/members/${member?.id}`, {
          body: { role: "owner" },
          method: "PATCH",
        }),
      ].map((response) => response.text())
    );

    expect(bodies.every((body) => body.length > 0)).toBe(true);
    // The same sweep the resource routers get in `identity.test.ts`: one
    // assertion, and a failure names the field that leaked.
    expect(bodies.flatMap(findClerkIdLeaksInBody)).toEqual([]);
  });
});
