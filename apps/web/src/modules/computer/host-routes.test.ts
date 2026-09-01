import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { ApiEnv } from "#/api/types";
import type { Db } from "#/db/client";

/**
 * The computer hosts API. Two things are load-bearing here and neither is
 * about happy paths: a self-hosted host's token exists in exactly one response
 * and never again, and no response anywhere carries a hash, a ciphertext or
 * the Fly API token.
 *
 * No network: the Fly probe and the host transport are both injected, because
 * there is no Fly account behind any of this yet.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

let signedInAs: string | null = null;
mock.module("@clerk/hono", () => ({
  getAuth: () => (signedInAs ? { userId: signedInAs } : null),
}));

const ADA_ID = "user_2aAdaAAAAAAAAAAAAAAAAAAA";
const BOB_ID = "user_2bBobBBBBBBBBBBBBBBBBBBB";
const FLY_TOKEN = "fly_deploy_token_abcd";

const { createDb } = await import("#/db/client");
const { generateConnectorKey } = await import("#/crypto");
const { hashMcpToken } = await import("#/modules/agents/mcp-token");
const { createAgent } = await import("#/modules/agents/service");
const { addMember, createWorkspace } = await import(
  "#/modules/workspaces/service"
);
const { workspaceScopedRoutes } = await import("#/modules/workspaces/routes");
const { createComputerHostRoutes } = await import("./host-routes");
const { getHostByIdUnscoped } = await import("./hosts");
const { ComputerTransportError } = await import("./remote-client");

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

/** What the injected Fly probe and transport were told to do, per test. */
let flyProbeAnswer = true;
let probedWith: { app: string; token: string }[] = [];
let pingReply: unknown = { hostname: "office-box", ok: true, version: "1.0.0" };
let pingThrows: Error | null = null;

workspaceScopedRoutes.route(
  "/computer-hosts",
  createComputerHostRoutes({
    flyProbe: (input) => {
      probedWith.push(input);
      return Promise.resolve(flyProbeAnswer);
    },
    transportFor: () =>
      Promise.resolve({
        send: (message) => {
          if (pingThrows) {
            return Promise.reject(pingThrows);
          }
          return Promise.resolve({ id: message.id, result: pingReply });
        },
      }),
  })
);

const app = new Hono<ApiEnv>();
app.route("/api/w/:workspaceSlug", workspaceScopedRoutes);

let db: Db;
let env: Env;
let alphaId: string;

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

interface HostBody {
  host: {
    agentIds: string[];
    config: Record<string, unknown>;
    flyApiTokenHint: string | null;
    id: string;
    kind: string;
    status: string;
  };
  token: string | null;
}

const postHost = async (body: Record<string, unknown>) => {
  const response = await request("/api/w/alpha/computer-hosts", {
    body,
    method: "POST",
  });
  return { body: (await response.json()) as HostBody, response };
};

const newSelfHostedHost = (name = "office-box") =>
  postHost({ kind: "self_hosted", name });

const newFlyHost = (name = "fly-eu") =>
  postHost({
    config: { app: "agentum-computers", volume_gb: 10 },
    flyApiToken: FLY_TOKEN,
    kind: "fly",
    name,
  });

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = { CONNECTOR_KEY: generateConnectorKey(), DB: d1 } as unknown as Env;
  flyProbeAnswer = true;
  probedWith = [];
  pingReply = { hostname: "office-box", ok: true, version: "1.0.0" };
  pingThrows = null;

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
  await addMember(db, alphaId, {
    clerkUserId: BOB_ID,
    email: "bob@example.com",
    imageUrl: null,
    name: "Bob",
    role: "member",
  });
});

describe("POST /computer-hosts", () => {
  test("a self-hosted host shows its token exactly once", async () => {
    const created = await newSelfHostedHost();

    expect(created.response.status).toBe(201);
    expect(typeof created.body.token).toBe("string");
    expect(created.body.host.status).toBe("unconfigured");

    // The one place it existed. Every later read has only the hash.
    const list = await (await request("/api/w/alpha/computer-hosts")).text();
    expect(list).not.toContain(created.body.token);
    expect(list).not.toContain(await hashMcpToken(created.body.token ?? ""));
  });

  test("a Fly host's daemon token is never handed out", async () => {
    const created = await newFlyHost();

    expect(created.response.status).toBe(201);
    // Agentum is the client on Fly, so it keeps the plaintext encrypted and
    // the user has nothing to paste anywhere.
    expect(created.body.token).toBeNull();
    const stored = await getHostByIdUnscoped(db, created.body.host.id);
    expect(stored?.tokenEnc).toBeTruthy();
    expect(stored?.tokenHash).toBeNull();
  });

  test("the Fly API token is validated before it is stored, and only hinted after", async () => {
    const created = await newFlyHost();

    expect(probedWith).toEqual([
      { app: "agentum-computers", token: FLY_TOKEN },
    ]);
    expect(created.body.host.flyApiTokenHint).toBe("abcd");
    expect(JSON.stringify(created.body)).not.toContain(FLY_TOKEN);
  });

  test("a Fly token the API rejects is refused, and nothing is stored", async () => {
    flyProbeAnswer = false;

    const created = await newFlyHost();

    expect(created.response.status).toBe(400);
    const list = (await (
      await request("/api/w/alpha/computer-hosts")
    ).json()) as { hosts: unknown[] };
    expect(list.hosts).toEqual([]);
  });

  test("a Fly host needs an app and a token", async () => {
    const noApp = await postHost({
      config: {},
      flyApiToken: FLY_TOKEN,
      kind: "fly",
      name: "fly-eu",
    });
    const noToken = await postHost({
      config: { app: "agentum-computers" },
      kind: "fly",
      name: "fly-eu",
    });

    expect(noApp.response.status).toBe(400);
    expect(noToken.response.status).toBe(400);
  });

  test("a Fly token on a self-hosted host is a mistake worth naming", async () => {
    const created = await postHost({
      flyApiToken: FLY_TOKEN,
      kind: "self_hosted",
      name: "office-box",
    });

    expect(created.response.status).toBe(400);
  });

  test("names are unique within the workspace", async () => {
    await newSelfHostedHost();
    const duplicate = await newSelfHostedHost();

    expect(duplicate.response.status).toBe(409);
  });

  test("only owners may add a host", async () => {
    const response = await request("/api/w/alpha/computer-hosts", {
      as: BOB_ID,
      body: { kind: "self_hosted", name: "bobs-box" },
      method: "POST",
    });

    expect(response.status).toBe(403);
  });
});

describe("GET /computer-hosts", () => {
  test("lists the workspace's hosts with the agents on them", async () => {
    const created = await newSelfHostedHost();
    const { agent } = await createAgent(db, alphaId, {
      computer: "self_hosted",
      computerHostId: created.body.host.id,
      instructions: "",
      name: "Ada",
      soul: "",
    });

    const body = (await (
      await request("/api/w/alpha/computer-hosts")
    ).json()) as { hosts: HostBody["host"][] };

    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]?.agentIds).toEqual([agent.id]);
  });

  test("members may look, even though they may not change", async () => {
    await newSelfHostedHost();

    const response = await request("/api/w/alpha/computer-hosts", {
      as: BOB_ID,
    });

    expect(response.status).toBe(200);
  });

  test("another workspace's hosts are not in the list", async () => {
    await newSelfHostedHost();
    await createWorkspace(db, {
      name: "Beta",
      owner: {
        clerkUserId: ADA_ID,
        email: "ada@example.com",
        imageUrl: null,
        name: "Ada Lovelace",
      },
    });

    const body = (await (
      await request("/api/w/beta/computer-hosts")
    ).json()) as { hosts: unknown[] };

    expect(body.hosts).toEqual([]);
  });
});

describe("PATCH /computer-hosts/:id", () => {
  test("renames a host", async () => {
    const created = await newSelfHostedHost();

    const response = await request(
      `/api/w/alpha/computer-hosts/${created.body.host.id}`,
      { body: { name: "garage-box" }, method: "PATCH" }
    );

    expect(response.status).toBe(200);
    expect((await getHostByIdUnscoped(db, created.body.host.id))?.name).toBe(
      "garage-box"
    );
  });

  test("rotating a self-hosted token returns a new one and unconfigures the host", async () => {
    const created = await newSelfHostedHost();
    const before = await getHostByIdUnscoped(db, created.body.host.id);

    const body = (await (
      await request(`/api/w/alpha/computer-hosts/${created.body.host.id}`, {
        body: { rotateToken: true },
        method: "PATCH",
      })
    ).json()) as HostBody;

    expect(typeof body.token).toBe("string");
    expect(body.token).not.toBe(created.body.token);
    expect(body.host.status).toBe("unconfigured");
    const after = await getHostByIdUnscoped(db, created.body.host.id);
    expect(after?.tokenHash).not.toBe(before?.tokenHash);
    expect(after?.tokenHash).toBe(await hashMcpToken(body.token ?? ""));
  });

  test("rotating a Fly token re-encrypts it and still shows nothing", async () => {
    const created = await newFlyHost();
    const before = await getHostByIdUnscoped(db, created.body.host.id);

    const body = (await (
      await request(`/api/w/alpha/computer-hosts/${created.body.host.id}`, {
        body: { rotateToken: true },
        method: "PATCH",
      })
    ).json()) as HostBody;

    expect(body.token).toBeNull();
    const after = await getHostByIdUnscoped(db, created.body.host.id);
    expect(after?.tokenEnc).toBeTruthy();
    expect(after?.tokenEnc).not.toBe(before?.tokenEnc);
  });

  test("the kind is fixed once the host exists", async () => {
    const created = await newSelfHostedHost();

    const response = await request(
      `/api/w/alpha/computer-hosts/${created.body.host.id}`,
      { body: { kind: "fly" }, method: "PATCH" }
    );

    expect(response.status).toBe(400);
  });

  test("another workspace's host is a 404, not a 403", async () => {
    const created = await newSelfHostedHost();
    await createWorkspace(db, {
      name: "Beta",
      owner: {
        clerkUserId: ADA_ID,
        email: "ada@example.com",
        imageUrl: null,
        name: "Ada Lovelace",
      },
    });

    const response = await request(
      `/api/w/beta/computer-hosts/${created.body.host.id}`,
      { body: { name: "stolen" }, method: "PATCH" }
    );

    expect(response.status).toBe(404);
  });

  test("only owners may change a host", async () => {
    const created = await newSelfHostedHost();

    const response = await request(
      `/api/w/alpha/computer-hosts/${created.body.host.id}`,
      { as: BOB_ID, body: { name: "bobs-box" }, method: "PATCH" }
    );

    expect(response.status).toBe(403);
  });
});

describe("DELETE /computer-hosts/:id", () => {
  test("removes a host nothing is using", async () => {
    const created = await newSelfHostedHost();

    const response = await request(
      `/api/w/alpha/computer-hosts/${created.body.host.id}`,
      { method: "DELETE" }
    );

    expect(response.status).toBe(204);
    expect(await getHostByIdUnscoped(db, created.body.host.id)).toBeUndefined();
  });

  test("refuses while an agent still runs on it", async () => {
    const created = await newSelfHostedHost();
    await createAgent(db, alphaId, {
      computer: "self_hosted",
      computerHostId: created.body.host.id,
      instructions: "",
      name: "Ada",
      soul: "",
    });

    const response = await request(
      `/api/w/alpha/computer-hosts/${created.body.host.id}`,
      { method: "DELETE" }
    );

    expect(response.status).toBe(409);
    expect(await getHostByIdUnscoped(db, created.body.host.id)).toBeDefined();
  });

  test("another workspace's host is a 404", async () => {
    const created = await newSelfHostedHost();
    await createWorkspace(db, {
      name: "Beta",
      owner: {
        clerkUserId: ADA_ID,
        email: "ada@example.com",
        imageUrl: null,
        name: "Ada Lovelace",
      },
    });

    const response = await request(
      `/api/w/beta/computer-hosts/${created.body.host.id}`,
      { method: "DELETE" }
    );

    expect(response.status).toBe(404);
    expect(await getHostByIdUnscoped(db, created.body.host.id)).toBeDefined();
  });
});

describe("POST /computer-hosts/:id/test", () => {
  test("a host that answers is ready, and was seen just now", async () => {
    const created = await newSelfHostedHost();

    const body = (await (
      await request(
        `/api/w/alpha/computer-hosts/${created.body.host.id}/test`,
        { method: "POST" }
      )
    ).json()) as { hostname: string; ok: boolean; version: string };

    expect(body).toEqual({
      hostname: "office-box",
      ok: true,
      version: "1.0.0",
    });
    const host = await getHostByIdUnscoped(db, created.body.host.id);
    expect(host?.status).toBe("ready");
    expect(host?.lastSeenAt).toBeInstanceOf(Date);
  });

  test("a host that does not answer records why", async () => {
    const created = await newSelfHostedHost();
    pingThrows = new ComputerTransportError(
      "The computer host `office-box` is offline. Start the container and try again."
    );

    const body = (await (
      await request(
        `/api/w/alpha/computer-hosts/${created.body.host.id}/test`,
        { method: "POST" }
      )
    ).json()) as { ok: boolean; reason: string };

    expect(body.ok).toBe(false);
    expect(body.reason).toContain("offline");
    const host = await getHostByIdUnscoped(db, created.body.host.id);
    expect(host?.status).toBe("error");
    expect(host?.statusError).toContain("offline");
    expect(host?.lastSeenAt).toBeNull();
  });

  test("only owners may test a host", async () => {
    const created = await newSelfHostedHost();

    const response = await request(
      `/api/w/alpha/computer-hosts/${created.body.host.id}/test`,
      { as: BOB_ID, method: "POST" }
    );

    expect(response.status).toBe(403);
  });
});
