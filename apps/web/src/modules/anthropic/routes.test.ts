import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import { generateConnectorKey } from "#/crypto";
import { createDb, type Db } from "#/db/client";
import { findClerkIdLeaksInBody } from "#/modules/workspaces/clerk-id-leaks";
import {
  appConfig,
  environmentIdKeyFor,
  workspaceAnthropicKeys,
} from "./schema";

/**
 * `/api/w/:slug/anthropic-key` end to end: the same mount `server.ts` makes,
 * over the shipped migrations in an in-memory database.
 *
 * Three packages are faked at their boundary so the router under test is the
 * one that ships - the Clerk session, the Clerk directory, and the Anthropic
 * SDK, whose `models.list` is the live validation call. Nothing here touches
 * the network.
 */

const OWNER_ID = "user_2aOwnerAAAAAAAAAAAAAAAAAA";
const MEMBER_ID = "user_2bMemberBBBBBBBBBBBBBBB";
const OUTSIDER_ID = "user_2cOutsiderCCCCCCCCCCCC";

const GOOD_KEY = "sk-ant-api03-a-perfectly-fine-key-cD3f";

/** A `Date` serializes to ISO 8601, which is what the settings page parses. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const clerkUser = (id: string, email: string) => ({
  emailAddresses: [{ emailAddress: email }],
  firstName: email.split("@")[0] ?? null,
  id,
  imageUrl: `https://images.example.com/${email.split("@")[0]}.png`,
  lastName: "Tester",
  primaryEmailAddress: { emailAddress: email },
});

const directory = new Map([
  [OWNER_ID, clerkUser(OWNER_ID, "ada@example.com")],
  [MEMBER_ID, clerkUser(MEMBER_ID, "grace@example.com")],
  [OUTSIDER_ID, clerkUser(OUTSIDER_ID, "alan@example.com")],
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
      getUserList: () => Promise.resolve({ data: [] }),
    },
  }),
}));

/** Every key the SDK was constructed with, so "the candidate is what we probe". */
let probedKeys: string[] = [];
/** What Anthropic says about the candidate key on the next `models.list`. */
let anthropicAccepts = true;

mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    models = {
      list: () => {
        if (anthropicAccepts) {
          return Promise.resolve({ data: [] });
        }
        // Deliberately quotes the key, the way a real SDK error quotes the
        // request: nothing may forward this message to the client.
        return Promise.reject(
          new Error(`401 invalid x-api-key: ${probedKeys.at(-1)}`)
        );
      },
    };

    constructor(options: { apiKey: string }) {
      probedKeys.push(options.apiKey);
    }
  },
}));

const { anthropicKeyRoutes } = await import("./routes");
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { addMember, createWorkspace, getWorkspaceBySlug } = await import(
  "#/modules/workspaces/service"
);

const MIGRATIONS_DIR = new URL("../../../drizzle", import.meta.url).pathname;

/** The three statement methods drizzle's D1 driver calls, over `bun:sqlite`. */
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

// Mounted the way `server.ts` mounts it, and before the mount below: Hono
// copies a sub-router's routes at mount time.
workspaceScopedRoutes.route("/anthropic-key", anthropicKeyRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let d1: D1Database;
let db: Db;
let env: Env;

const request = (
  init: {
    as?: string | null;
    body?: unknown;
    method?: string;
    slug?: string;
  } = {}
) => {
  signedInAs = init.as === undefined ? OWNER_ID : init.as;
  return app.request(
    `/api/w/${init.slug ?? "acme-rockets"}/anthropic-key`,
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

const put = (apiKey: string, as?: string) =>
  request({ body: { apiKey }, method: "PUT", ...(as ? { as } : {}) });

const snapshotOf = (clerkUserId: string) => {
  const user = directory.get(clerkUserId);
  if (!user) {
    throw new Error(`No fake Clerk user ${clerkUserId}.`);
  }
  return {
    clerkUserId,
    email: user.primaryEmailAddress.emailAddress,
    imageUrl: user.imageUrl,
    name: `${user.firstName} ${user.lastName}`,
  };
};

const storedRows = () => db.select().from(workspaceAnthropicKeys);

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  env = {
    CLERK_SECRET_KEY: "sk_test_fake",
    CONNECTOR_KEY: generateConnectorKey(),
    DB: d1,
  } as unknown as Env;
  probedKeys = [];
  anthropicAccepts = true;

  const { workspace } = await createWorkspace(db, {
    name: "Acme Rockets",
    owner: snapshotOf(OWNER_ID),
  });
  await addMember(db, workspace.id, {
    ...snapshotOf(MEMBER_ID),
    role: "member",
  });
});

describe("the workspace gates", () => {
  test("answers 404 to somebody who is not a member at all", async () => {
    expect((await request({ as: OUTSIDER_ID })).status).toBe(404);
  });

  test("answers 401 when nobody is signed in", async () => {
    expect((await request({ as: null })).status).toBe(401);
  });

  test("answers 403 to a member on every verb, key or no key", async () => {
    const read = await request({ as: MEMBER_ID });
    const write = await put(GOOD_KEY, MEMBER_ID);
    const remove = await request({ as: MEMBER_ID, method: "DELETE" });

    expect([read.status, write.status, remove.status]).toEqual([403, 403, 403]);
    expect(await storedRows()).toHaveLength(0);
    // A refused write must not even reach the API with the candidate key.
    expect(probedKeys).toEqual([]);
  });
});

describe("GET /anthropic-key", () => {
  test("reports the fallback to the platform key", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      configured: false,
      hint: null,
      setAt: null,
    });
  });
});

describe("PUT /anthropic-key", () => {
  test("stores a validated key and answers with its hint", async () => {
    const response = await put(GOOD_KEY);

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      configured: true,
      hint: "cD3f",
      setAt: expect.stringMatching(ISO_DATE),
    });
    expect(probedKeys).toEqual([GOOD_KEY]);
  });

  test("never echoes the key, or who set it", async () => {
    const body = await (await put(GOOD_KEY)).text();

    expect(body).not.toContain(GOOD_KEY);
    expect(findClerkIdLeaksInBody(body)).toEqual([]);
  });

  test("stores the key encrypted", async () => {
    await put(GOOD_KEY);

    const [row] = await storedRows();
    expect(row?.apiKeyEnc).not.toContain(GOOD_KEY);
    expect(row?.setByClerkUserId).toBe(OWNER_ID);
  });

  test("rejects something that is not an Anthropic key, without calling out", async () => {
    const response = await put("sk-proj-this-is-an-openai-key");

    expect(response.status).toBe(400);
    expect(probedKeys).toEqual([]);
    expect(await storedRows()).toHaveLength(0);
  });

  test("rejects a missing apiKey", async () => {
    expect((await request({ body: {}, method: "PUT" })).status).toBe(400);
  });

  test("fails closed when Anthropic rejects the key", async () => {
    anthropicAccepts = false;

    const response = await put(GOOD_KEY);

    expect(response.status).toBe(422);
    expect(await storedRows()).toHaveLength(0);
    // The SDK's own message quotes the key; ours must not repeat it.
    expect(await response.text()).not.toContain(GOOD_KEY);
  });

  test("refuses when the deployment cannot encrypt, before calling out", async () => {
    env = { ...env, CONNECTOR_KEY: "" } as unknown as Env;

    const response = await put(GOOD_KEY);

    expect(response.status).toBe(503);
    expect(probedKeys).toEqual([]);
    expect(await storedRows()).toHaveLength(0);
  });

  test("rotates in place rather than adding a second row", async () => {
    await put(GOOD_KEY);
    const response = await put("sk-ant-api03-the-replacement-9xYz");

    expect(await bodyOf(response)).toMatchObject({ hint: "9xYz" });
    expect(await storedRows()).toHaveLength(1);
  });

  test("is scoped to the workspace in the path", async () => {
    const { workspace } = await createWorkspace(db, {
      name: "Globex",
      owner: snapshotOf(OUTSIDER_ID),
    });
    await put(GOOD_KEY);

    const [row] = await storedRows();
    expect(row?.workspaceId).not.toBe(workspace.id);

    const theirs = await request({ as: OUTSIDER_ID, slug: "globex" });
    expect(await bodyOf(theirs)).toMatchObject({ configured: false });
  });
});

describe("DELETE /anthropic-key", () => {
  test("removes the key and reports the fallback", async () => {
    await put(GOOD_KEY);

    const response = await request({ method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      configured: false,
      hint: null,
      setAt: null,
    });
    expect(await storedRows()).toHaveLength(0);
  });

  test("is idempotent when no key was ever set", async () => {
    const response = await request({ method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      configured: false,
      hint: null,
      setAt: null,
    });
  });
});

describe("the resource reset", () => {
  test("drops the workspace's environment cache entry on a key change", async () => {
    const workspace = await getWorkspaceBySlug(db, "acme-rockets");
    if (!workspace) {
      throw new Error("The seeded workspace is gone.");
    }
    const cacheKey = environmentIdKeyFor(workspace.id);
    await db.insert(appConfig).values({ key: cacheKey, value: "env_old" });

    await put(GOOD_KEY);

    expect(
      await db.select().from(appConfig).where(eq(appConfig.key, cacheKey))
    ).toHaveLength(0);
  });
});
