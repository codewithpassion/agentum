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

/**
 * The computer lifecycle hooks, recorded instead of run: creating an agent on a
 * Fly host would otherwise call the Machines API from a test, and there is no
 * Fly account behind any of this. What they do is `computer/lifecycle.test.ts`.
 */
const provisionedFor: string[] = [];
const tornDownFor: string[] = [];
mock.module("#/modules/computer/lifecycle", () => ({
  onAgentComputerCreated: (
    _db: unknown,
    _env: unknown,
    agent: { id: string }
  ) => {
    provisionedFor.push(agent.id);
    return Promise.resolve();
  },
  onAgentComputerDeleted: (
    _db: unknown,
    _env: unknown,
    agent: { id: string }
  ) => {
    tornDownFor.push(agent.id);
    return Promise.resolve();
  },
  onFlyHostTokenRotated: () => Promise.resolve(),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const OPUS = "claude-opus-5";

const { createDb } = await import("#/db/client");
const { generateConnectorKey } = await import("#/crypto");
const { createHost } = await import("#/modules/computer/hosts");
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
let alphaId: string;

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
    CONNECTOR_KEY: generateConnectorKey(),
    DB: d1,
  } as unknown as Env;

  const alpha = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  alphaId = alpha.workspace.id;
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

describe("the runtime", () => {
  const CF_MODEL = "@cf/moonshotai/kimi-k2.5";

  interface RuntimeBody {
    agent: {
      id: string;
      model: string | null;
      runtime: string;
      syncStatus: string;
    };
  }

  test("defaults to managed", async () => {
    const created = await postAgent({});

    expect((created.body as unknown as RuntimeBody).agent.runtime).toBe(
      "managed"
    );
  });

  test("a Cloudflare agent is ready the moment it exists", async () => {
    const created = await postAgent({ model: CF_MODEL, runtime: "cloudflare" });
    const body = created.body as unknown as RuntimeBody;

    expect(created.response.status).toBe(201);
    expect(body.agent.runtime).toBe("cloudflare");
    expect(body.agent.model).toBe(CF_MODEL);
    // Nothing to register: "synced" is what the rail reads as ready.
    expect(body.agent.syncStatus).toBe("synced");
  });

  test("rejects an unknown runtime", async () => {
    const response = await request("/api/w/alpha/agents", {
      body: { name: "Ada", runtime: "lambda" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      '"runtime" must be one of: managed, cloudflare.'
    );
  });

  test("validates the model against the runtime, not the Anthropic catalog", async () => {
    // A Cloudflare agent may not run an Anthropic catalog id...
    const catalog = await request("/api/w/alpha/agents", {
      body: { model: OPUS, name: "Ada", runtime: "cloudflare" },
      method: "POST",
    });
    expect(catalog.status).toBe(400);
    // ...and a managed agent may not run a Workers AI id.
    const workersAi = await request("/api/w/alpha/agents", {
      body: { model: CF_MODEL, name: "Ada" },
      method: "POST",
    });
    expect(workersAi.status).toBe(400);
    // AI Gateway references are the other valid shape.
    const gateway = await postAgent({
      model: "anthropic/claude-sonnet-4-5",
      runtime: "cloudflare",
    });
    expect(gateway.response.status).toBe(201);
  });

  test("an edit validates the model against the agent's own runtime", async () => {
    const created = await postAgent({ runtime: "cloudflare" });

    const rejected = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { model: OPUS }, method: "PATCH" }
    );
    expect(rejected.status).toBe(400);

    const accepted = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { model: CF_MODEL }, method: "PATCH" }
    );
    expect(((await accepted.json()) as AgentBody).agent.model).toBe(CF_MODEL);
  });

  test("cannot be changed after creation", async () => {
    const created = await postAgent({ runtime: "cloudflare" });

    const response = await request(
      `/api/w/alpha/agents/${created.body.agent.id}`,
      { body: { runtime: "managed" }, method: "PATCH" }
    );

    expect(response.status).toBe(400);
    const after = await request(`/api/w/alpha/agents/${created.body.agent.id}`);
    expect(((await after.json()) as unknown as RuntimeBody).agent.runtime).toBe(
      "cloudflare"
    );
  });
});

describe("the computer", () => {
  interface ComputerBody {
    agent: { computer: string; computerHostId: string | null; id: string };
  }

  const newHost = async (
    input: {
      kind?: "fly" | "self_hosted";
      name?: string;
      workspaceId?: string;
    } = {}
  ) => {
    const { host } = await createHost(
      db,
      env,
      input.workspaceId ?? alphaId,
      input.kind === "fly"
        ? {
            config: { app: "agentum-computers" },
            flyApiToken: "fly_token",
            kind: "fly",
            name: input.name ?? "fly-eu",
          }
        : { config: {}, kind: "self_hosted", name: input.name ?? "office-box" }
    );
    return host;
  };

  test("defaults to cloudflare, on no host", async () => {
    const created = await postAgent({});
    const body = created.body as unknown as ComputerBody;

    expect(body.agent.computer).toBe("cloudflare");
    expect(body.agent.computerHostId).toBeNull();
  });

  test("rejects a computer nobody offers", async () => {
    const response = await request("/api/w/alpha/agents", {
      body: { computer: "my-laptop", name: "Ada" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      '"computer" must be one of: cloudflare, fly, self_hosted.'
    );
  });

  test("a remote computer needs a host, and a cloudflare one may not have any", async () => {
    const host = await newHost();

    const missing = await request("/api/w/alpha/agents", {
      body: { computer: "self_hosted", name: "Ada" },
      method: "POST",
    });
    const uninvited = await request("/api/w/alpha/agents", {
      body: { computerHostId: host.id, name: "Ada" },
      method: "POST",
    });

    expect(missing.status).toBe(400);
    expect(uninvited.status).toBe(400);
  });

  test("the host must match the computer that was asked for", async () => {
    const host = await newHost({ kind: "fly" });

    const response = await request("/api/w/alpha/agents", {
      body: { computer: "self_hosted", computerHostId: host.id, name: "Ada" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "is a fly host"
    );
  });

  test("another workspace's host is not a host this agent may use", async () => {
    const beta = await createWorkspace(db, {
      name: "Beta",
      owner: {
        clerkUserId: ADA_ID,
        email: "ada@example.com",
        imageUrl: null,
        name: "Ada Lovelace",
      },
    });
    const host = await newHost({ workspaceId: beta.workspace.id });

    const response = await request("/api/w/alpha/agents", {
      body: { computer: "self_hosted", computerHostId: host.id, name: "Ada" },
      method: "POST",
    });

    expect(response.status).toBe(400);
  });

  test("a self-hosted host takes one agent", async () => {
    const host = await newHost();
    const first = await postAgent({
      computer: "self_hosted",
      computerHostId: host.id,
    });
    expect(first.response.status).toBe(201);

    const second = await request("/api/w/alpha/agents", {
      body: { computer: "self_hosted", computerHostId: host.id, name: "Bob" },
      method: "POST",
    });

    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toContain(
      "already runs an agent"
    );
  });

  test("a valid pair is stored and shown", async () => {
    const host = await newHost({ kind: "fly" });

    const created = await postAgent({
      computer: "fly",
      computerHostId: host.id,
    });
    const body = created.body as unknown as ComputerBody;

    expect(created.response.status).toBe(201);
    expect(body.agent.computer).toBe("fly");
    expect(body.agent.computerHostId).toBe(host.id);
    // The machine and its volume are created in the background of this
    // request, the way the Anthropic registration is.
    expect(provisionedFor).toContain(body.agent.id);
  });

  test("neither half can be changed after creation", async () => {
    const host = await newHost();
    const created = await postAgent({
      computer: "self_hosted",
      computerHostId: host.id,
    });
    const path = `/api/w/alpha/agents/${created.body.agent.id}`;

    const movedComputer = await request(path, {
      body: { computer: "cloudflare" },
      method: "PATCH",
    });
    const movedHost = await request(path, {
      body: { computerHostId: crypto.randomUUID() },
      method: "PATCH",
    });

    expect(movedComputer.status).toBe(400);
    expect(movedHost.status).toBe(400);
    const after = (await (
      await request(path)
    ).json()) as unknown as ComputerBody;
    expect(after.agent.computer).toBe("self_hosted");
    expect(after.agent.computerHostId).toBe(host.id);
  });
});
