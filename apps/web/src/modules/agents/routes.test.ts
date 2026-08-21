import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";

/**
 * The model field on the agents API. The catalog is the validation boundary:
 * a model the deployment does not offer is a 400 here, so nothing that reaches
 * the gateway was ever taken on trust from a client.
 *
 * No Anthropic key in the fake env, so the background registration the routes
 * kick off is a no-op and no network is touched.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const OPUS = "claude-opus-5";

const { createDb } = await import("#/db/client");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { agentsRoutes } = await import("./routes");

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
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

workspaceScopedRoutes.route("/agents", agentsRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let db: Db;
let env: Env;

const request = (
  path: string,
  init: { body?: unknown; method?: string } = {}
) => {
  signedInAs = ADA_ID;
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

interface AgentBody {
  agent: { id: string; model: string | null };
}

const postAgent = async (body: Record<string, unknown>) => {
  const response = await request("/api/w/alpha/agents", {
    body: { name: `Agent-${crypto.randomUUID().slice(0, 8)}`, ...body },
    method: "POST",
  });
  return { body: (await response.json()) as AgentBody, response };
};

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = {
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  } as unknown as Env;

  await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
});

describe("POST /agents", () => {
  test("stores a catalog model", async () => {
    const created = await postAgent({ model: OPUS });

    expect(created.response.status).toBe(201);
    expect(created.body.agent.model).toBe(OPUS);
  });

  test("leaves the model null when none is given", async () => {
    const created = await postAgent({});

    expect(created.body.agent.model).toBeNull();
  });

  test("rejects a model that is not in the catalog", async () => {
    const response = await request("/api/w/alpha/agents", {
      body: { model: "gpt-9", name: "Ada" },
      method: "POST",
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    // The message names what is on offer, so a client can correct itself.
    expect(body.error).toBe(
      '"model" must be one of: claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001.'
    );
  });
});

describe("PATCH /agents/:id", () => {
  test("changes the model", async () => {
    const created = await postAgent({});

    const response = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { model: OPUS }, method: "PATCH" }
    );

    expect(((await response.json()) as AgentBody).agent.model).toBe(OPUS);
  });

  test("null puts the agent back on the workspace default", async () => {
    const created = await postAgent({ model: OPUS });

    const response = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { model: null }, method: "PATCH" }
    );

    expect(((await response.json()) as AgentBody).agent.model).toBeNull();
  });

  test("an edit that says nothing about the model leaves it alone", async () => {
    const created = await postAgent({ model: OPUS });

    const response = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { soul: "curious" }, method: "PATCH" }
    );

    expect(((await response.json()) as AgentBody).agent.model).toBe(OPUS);
  });

  test("rejects a model that is not in the catalog", async () => {
    const created = await postAgent({ model: OPUS });

    const response = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { model: "claude-retired-1" }, method: "PATCH" }
    );

    expect(response.status).toBe(400);
    // And the stored model is untouched.
    const after = await request(`/api/w/alpha/agents/${created.body.agent.id}`);
    expect(((await after.json()) as AgentBody).agent.model).toBe(OPUS);
  });
});
