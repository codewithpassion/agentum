import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";

/**
 * The model field on the routines API. The catalog is the validation boundary
 * on this side too: a routine may only name a model the deployment offers, so
 * the override `fireRoutine` writes can never be a model nobody can run.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const OPUS = "claude-opus-5";

const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { createChannel } = await import("#/modules/messaging/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { routinesRoutes } = await import("./routes");

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

workspaceScopedRoutes.route("/routines", routinesRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let db: Db;
let env: Env;
let agentId: string;
let channelId: string;

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

interface RoutineBody {
  error?: string;
  routine: { id: string; model: string | null };
}

const postRoutine = async (body: Record<string, unknown>) => {
  const response = await request("/api/w/alpha/routines", {
    body: {
      agentId,
      channelId,
      instructions: "Summarize yesterday.",
      name: "Morning summary",
      schedule: { time: "09:00", type: "daily" },
      timezone: "Australia/Sydney",
      ...body,
    },
    method: "POST",
  });
  return { body: (await response.json()) as RoutineBody, response };
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
    ROUTINE_SCHEDULER: {
      get: () => ({ reschedule: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
  } as unknown as Env;

  const { workspace } = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  ({
    agent: { id: agentId },
  } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Ada",
    soul: "",
  }));
  ({ id: channelId } = await createChannel(db, workspace.id, { name: "ops" }));
});

describe("POST /routines", () => {
  test("stores a catalog model", async () => {
    const created = await postRoutine({ model: OPUS });

    expect(created.response.status).toBe(201);
    expect(created.body.routine.model).toBe(OPUS);
  });

  test("leaves the model null when none is given", async () => {
    const created = await postRoutine({});

    expect(created.body.routine.model).toBeNull();
  });

  test("rejects a model that is not in the catalog", async () => {
    const created = await postRoutine({ model: "gpt-9" });

    expect(created.response.status).toBe(400);
    expect(created.body.error).toBe(
      '"model" must be one of: claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001.'
    );
  });
});

describe("PATCH /routines/:id", () => {
  test("changes the model", async () => {
    const created = await postRoutine({});

    const response = await request(
      `/api/w/alpha/routines/${created.body.routine.id}`,
      { body: { model: OPUS }, method: "PATCH" }
    );

    expect(((await response.json()) as RoutineBody).routine.model).toBe(OPUS);
  });

  test("null puts the routine back on its agent's model", async () => {
    const created = await postRoutine({ model: OPUS });

    const response = await request(
      `/api/w/alpha/routines/${created.body.routine.id}`,
      { body: { model: null }, method: "PATCH" }
    );

    expect(((await response.json()) as RoutineBody).routine.model).toBeNull();
  });

  test("an edit that says nothing about the model leaves it alone", async () => {
    const created = await postRoutine({ model: OPUS });

    const response = await request(
      `/api/w/alpha/routines/${created.body.routine.id}`,
      { body: { name: "Renamed" }, method: "PATCH" }
    );

    expect(((await response.json()) as RoutineBody).routine.model).toBe(OPUS);
  });

  test("rejects a model that is not in the catalog", async () => {
    const created = await postRoutine({});

    const response = await request(
      `/api/w/alpha/routines/${created.body.routine.id}`,
      { body: { model: "gpt-9" }, method: "PATCH" }
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as RoutineBody).error).toContain(
      "claude-opus-5"
    );
  });
});
