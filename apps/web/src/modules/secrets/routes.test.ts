import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";

/**
 * The secrets API.
 *
 * Two things are load-bearing and neither is a happy path: a value exists in
 * exactly one request and never in any response, and an owner is the only
 * person who can write one. The cross-tenant cases live in
 * `workspaces/isolation.test.ts` as well, where they are swept alongside every
 * other router; the ones here are the module's own.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";
const VALUE = "dg-0123456789abcdef";

const { createDb } = await import("#/db/client");
const { generateConnectorKey } = await import("#/crypto");
const { createAgent } = await import("#/modules/agents/service");
const { addMember, createWorkspace } = await import(
  "#/modules/workspaces/service"
);
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { secretsRoutes } = await import("./routes");
const { getSecret, listSecrets } = await import("./service");

const MIGRATIONS_DIR = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, MIGRATIONS_DIR),
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

workspaceScopedRoutes.route("/secrets", secretsRoutes);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let db: Db;
let env: Env;
let alphaAgentId: string;
let betaAgentId: string;
let betaSecretId: string;

const request = (
  path: string,
  init: { as?: string; body?: unknown; method?: string } = {}
) => {
  signedInAs = init.as ?? ADA_ID;
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

interface SecretBody {
  error?: string;
  secret: {
    agentIds: string[];
    allowedHosts: string[];
    header: string;
    headerPrefix: string;
    hint: string;
    id: string;
    name: string;
    syncStatus: string;
  };
}

const postSecret = async (
  body: Record<string, unknown> = {},
  init: { as?: string } = {}
) => {
  const response = await request("/api/w/alpha/secrets", {
    ...init,
    body: {
      allowedHosts: ["api.deepgram.com"],
      name: "DEEPGRAM_API_KEY",
      value: VALUE,
      ...body,
    },
    method: "POST",
  });
  return { body: (await response.json()) as SecretBody, response };
};

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = { CONNECTOR_KEY: generateConnectorKey(), DB: d1 } as unknown as Env;

  const alpha = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: ADA_ID,
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada Lovelace",
    },
  });
  await addMember(db, alpha.workspace.id, {
    clerkUserId: BOB_ID,
    email: "bob@example.com",
    imageUrl: null,
    name: "Bob",
    role: "member",
  });
  alphaAgentId = (
    await createAgent(db, alpha.workspace.id, {
      instructions: "",
      name: "Ada",
      soul: "",
    })
  ).agent.id;

  // A second workspace Ada has nothing to do with, for the oracle cases.
  const beta = await createWorkspace(db, {
    name: "Beta",
    owner: {
      clerkUserId: BOB_ID,
      email: "bob@example.com",
      imageUrl: null,
      name: "Bob",
    },
  });
  betaAgentId = (
    await createAgent(db, beta.workspace.id, {
      instructions: "",
      name: "Grace",
      soul: "",
    })
  ).agent.id;
  const { createSecret } = await import("./service");
  betaSecretId = (
    await createSecret(db, env, beta.workspace.id, {
      allowedHosts: ["api.deepgram.com"],
      clerkUserId: BOB_ID,
      name: "DEEPGRAM_API_KEY",
      value: VALUE,
    })
  ).id;
});

describe("POST /secrets", () => {
  test("stores a secret and answers with a hint, never the value", async () => {
    const created = await postSecret();

    expect(created.response.status).toBe(201);
    expect(created.body.secret.hint).toBe("cdef");
    expect(created.body.secret.name).toBe("DEEPGRAM_API_KEY");
    expect(created.body.secret.syncStatus).toBe("unregistered");
    expect(JSON.stringify(created.body)).not.toContain(VALUE);

    // And no later read has it either.
    const list = await (await request("/api/w/alpha/secrets")).text();
    expect(list).not.toContain(VALUE);
  });

  test("keeps a header prefix verbatim - the trailing space is load-bearing", async () => {
    const created = await postSecret({
      headerPrefix: "Token ",
      name: "DEEPGRAM_TOKEN",
    });
    expect(created.body.secret.headerPrefix).toBe("Token ");
  });

  test("accepts an empty prefix, for x-api-key style headers", async () => {
    const created = await postSecret({
      header: "x-api-key",
      headerPrefix: "",
      name: "OTHER_KEY",
    });
    expect(created.response.status).toBe(201);
    expect(created.body.secret.headerPrefix).toBe("");
  });

  test("a value with leading or trailing whitespace is stored as typed", async () => {
    const padded = `  ${VALUE}  `;
    const created = await postSecret({ value: padded });
    // The hint is of the *stored* value, so the two spaces are still there.
    expect(created.body.secret.hint).toBe("ef  ");
  });

  test("409 on a duplicate name in the same workspace", async () => {
    await postSecret();
    const again = await postSecret();
    expect(again.response.status).toBe(409);
    expect(again.body.error).toContain("DEEPGRAM_API_KEY");
  });

  test.each([
    ["lower_case", "deepgram_api_key"],
    ["a leading digit", "1DEEPGRAM"],
    ["a hyphen", "DEEPGRAM-KEY"],
    ["one character", "D"],
    ["a space", "DEEPGRAM KEY"],
  ])("400 for a name with %s", async (_label, name) => {
    const created = await postSecret({ name });
    expect(created.response.status).toBe(400);
  });

  test.each([
    ["no hosts", []],
    ["a URL", ["https://api.deepgram.com"]],
    ["a private address", ["127.0.0.1"]],
    ["a port", ["api.deepgram.com:443"]],
    ["seventeen hosts", Array.from({ length: 17 }, (_, i) => `h${i}.test.com`)],
  ])("400 for %s", async (_label, allowedHosts) => {
    const created = await postSecret({ allowedHosts });
    expect(created.response.status).toBe(400);
  });

  test("400 when allowedHosts is missing entirely", async () => {
    const response = await request("/api/w/alpha/secrets", {
      body: { name: "DEEPGRAM_API_KEY", value: VALUE },
      method: "POST",
    });
    expect(response.status).toBe(400);
  });

  test("400 for a value that is too short, too long, or a header injection", async () => {
    const short = await postSecret({ value: "abc" });
    const long = await postSecret({ value: "x".repeat(4097) });
    const split = await postSecret({ value: "abcdefgh\r\nX-Evil: 1" });

    expect([
      short.response.status,
      long.response.status,
      split.response.status,
    ]).toEqual([400, 400, 400]);
  });

  test("no error message ever quotes the value", async () => {
    const responses = await Promise.all([
      postSecret({ name: "bad name" }),
      postSecret({ allowedHosts: ["127.0.0.1"] }),
      postSecret({ header: "bad header" }),
    ]);
    for (const { body } of responses) {
      expect(JSON.stringify(body)).not.toContain(VALUE);
    }
  });

  test("400 for a header name that is not a header name", async () => {
    const created = await postSecret({ header: "X-Evil: injected" });
    expect(created.response.status).toBe(400);
  });

  test("503 when the deployment has no CONNECTOR_KEY to encrypt with", async () => {
    env = { DB: env.DB } as unknown as Env;
    const created = await postSecret();
    expect(created.response.status).toBe(503);
    expect(created.body.error).not.toContain(VALUE);
  });
});

describe("GET /secrets", () => {
  test("any member may list; the list carries hints and grants, not values", async () => {
    const created = await postSecret();
    await request(
      `/api/w/alpha/secrets/${created.body.secret.id}/agents/${alphaAgentId}`,
      { method: "PUT" }
    );

    const response = await request("/api/w/alpha/secrets", { as: BOB_ID });
    const body = (await response.json()) as { secrets: SecretBody["secret"][] };

    expect(response.status).toBe(200);
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]?.agentIds).toEqual([alphaAgentId]);
    expect(body.secrets[0]?.hint).toBe("cdef");
  });

  test("shows only its own workspace's secrets", async () => {
    await postSecret();
    const body = (await (await request("/api/w/alpha/secrets")).json()) as {
      secrets: { id: string }[];
    };
    expect(body.secrets.map((row) => row.id)).not.toContain(betaSecretId);
  });
});

describe("PATCH /secrets/:id", () => {
  test("rotates the value: new hint, and the value is still never returned", async () => {
    const created = await postSecret();
    const response = await request(
      `/api/w/alpha/secrets/${created.body.secret.id}`,
      { body: { value: "dg-fedcba9876543210" }, method: "PATCH" }
    );
    const body = (await response.json()) as SecretBody;

    expect(response.status).toBe(200);
    expect(body.secret.hint).toBe("3210");
    expect(await response.clone().text()).not.toContain("dg-fedcba9876543210");
  });

  test("edits hosts, header, prefix and description", async () => {
    const created = await postSecret();
    const response = await request(
      `/api/w/alpha/secrets/${created.body.secret.id}`,
      {
        body: {
          allowedHosts: ["*.deepgram.com", "api.deepgram.com"],
          description: "Transcription",
          header: "x-api-key",
          headerPrefix: "",
        },
        method: "PATCH",
      }
    );
    const body = (await response.json()) as SecretBody;

    expect(body.secret.allowedHosts).toEqual([
      "*.deepgram.com",
      "api.deepgram.com",
    ]);
    expect(body.secret.header).toBe("x-api-key");
    expect(body.secret.headerPrefix).toBe("");
  });

  test("400 when the body tries to rename: a name is not patchable", async () => {
    const created = await postSecret();
    const response = await request(
      `/api/w/alpha/secrets/${created.body.secret.id}`,
      { body: { name: "OTHER_KEY" }, method: "PATCH" }
    );
    expect(response.status).toBe(400);
  });

  test("404 for an id that is not this workspace's", async () => {
    const response = await request(`/api/w/alpha/secrets/${betaSecretId}`, {
      body: { description: "Stolen" },
      method: "PATCH",
    });
    expect(response.status).toBe(404);
  });
});

describe("DELETE /secrets/:id", () => {
  test("204, and the row and its grants are gone", async () => {
    const {
      body: {
        secret: { id },
      },
    } = await postSecret();
    await request(`/api/w/alpha/secrets/${id}/agents/${alphaAgentId}`, {
      method: "PUT",
    });

    const response = await request(`/api/w/alpha/secrets/${id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(await listSecrets(db, (await currentWorkspaceId()) ?? "")).toEqual(
      []
    );
  });

  test("404 for another workspace's id, and that secret survives", async () => {
    const response = await request(`/api/w/alpha/secrets/${betaSecretId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    expect(await getSecretUnscoped(betaSecretId)).toBeDefined();
  });
});

describe("grants", () => {
  test("PUT grants, is idempotent, and DELETE revokes", async () => {
    const created = await postSecret();
    const path = `/api/w/alpha/secrets/${created.body.secret.id}/agents/${alphaAgentId}`;

    const first = await request(path, { method: "PUT" });
    const again = await request(path, { method: "PUT" });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(
      (await first.json()) as {
        appliesToNextSession: boolean;
        granted: boolean;
      }
    ).toEqual({ appliesToNextSession: true, granted: true });

    const revoked = await request(path, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    // Revoking again has nothing to revoke.
    expect((await request(path, { method: "DELETE" })).status).toBe(404);
  });

  /**
   * The existence oracle: another workspace's agent must be indistinguishable
   * from an agent that does not exist. A 403 would confirm the id is real.
   */
  test("404 for another workspace's agent, exactly as for a made-up one", async () => {
    const created = await postSecret();
    const base = `/api/w/alpha/secrets/${created.body.secret.id}/agents`;

    const theirs = await request(`${base}/${betaAgentId}`, { method: "PUT" });
    const fictional = await request(`${base}/agent_does_not_exist`, {
      method: "PUT",
    });

    expect([theirs.status, fictional.status]).toEqual([404, 404]);
    expect(await theirs.clone().text()).toBe(await fictional.clone().text());
  });

  test("404 for another workspace's secret, exactly as for a made-up one", async () => {
    const theirs = await request(
      `/api/w/alpha/secrets/${betaSecretId}/agents/${alphaAgentId}`,
      { method: "PUT" }
    );
    const fictional = await request(
      `/api/w/alpha/secrets/sec_nope/agents/${alphaAgentId}`,
      { method: "PUT" }
    );

    expect([theirs.status, fictional.status]).toEqual([404, 404]);
    expect(await theirs.clone().text()).toBe(await fictional.clone().text());
  });
});

describe("owner gating", () => {
  test("a member may list but may not write", async () => {
    const {
      body: {
        secret: { id },
      },
    } = await postSecret();

    const attempts = await Promise.all([
      request("/api/w/alpha/secrets", {
        as: BOB_ID,
        body: { allowedHosts: ["api.openai.com"], name: "X_KEY", value: VALUE },
        method: "POST",
      }),
      request(`/api/w/alpha/secrets/${id}`, {
        as: BOB_ID,
        body: { description: "x" },
        method: "PATCH",
      }),
      request(`/api/w/alpha/secrets/${id}`, { as: BOB_ID, method: "DELETE" }),
      request(`/api/w/alpha/secrets/${id}/agents/${alphaAgentId}`, {
        as: BOB_ID,
        method: "PUT",
      }),
      request(`/api/w/alpha/secrets/${id}/agents/${alphaAgentId}`, {
        as: BOB_ID,
        method: "DELETE",
      }),
    ]);

    expect(attempts.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403,
    ]);
    expect((await request("/api/w/alpha/secrets", { as: BOB_ID })).status).toBe(
      200
    );
  });
});

/** The workspace id behind the `alpha` slug, for assertions against the db. */
const currentWorkspaceId = async (): Promise<string | undefined> => {
  const { getWorkspaceBySlug } = await import("#/modules/workspaces/service");
  return (await getWorkspaceBySlug(db, "alpha"))?.id;
};

const getSecretUnscoped = async (id: string) => {
  const { getWorkspaceBySlug } = await import("#/modules/workspaces/service");
  const beta = await getWorkspaceBySlug(db, "beta");
  return beta ? await getSecret(db, beta.id, id) : undefined;
};
