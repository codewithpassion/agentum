import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Db } from "#/db/client";

/**
 * The daemon's front door. It is outside `requireAuth`, so the only thing
 * standing between the internet and a relay socket is the token check - and
 * the only thing a caller may learn from a failed one is that it failed.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createDb } = await import("#/db/client");
const { createHost } = await import("./hosts");
const { computerConnectRoutes } = await import("./connect-route");
const { computerHosts } = await import("./schema");
const { hashMcpToken } = await import("#/modules/agents/mcp-token");

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
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

const app = new Hono<{ Bindings: Env }>();
app.route("/api/computer-hosts", computerConnectRoutes);

let d1: D1Database;
let db: Db;
/** Which relay the upgrade reached, and what it was asked for. */
let handed: { url: string; upgrade: string | null }[] = [];
let addressed: string[] = [];

const envFor = (): Env =>
  ({
    COMPUTER_RELAY: {
      get: () => ({
        fetch: (request: Request) => {
          handed.push({
            upgrade: request.headers.get("Upgrade"),
            url: request.url,
          });
          return Promise.resolve(new Response(null, { status: 101 }));
        },
      }),
      idFromName: (name: string) => {
        addressed.push(name);
        return name;
      },
    },
    DB: d1,
  }) as unknown as Env;

const upgrade = async (token: string | null): Promise<Response> =>
  await app.request(
    "/api/computer-hosts/connect",
    {
      headers: {
        Upgrade: "websocket",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
    envFor()
  );

beforeEach(() => {
  d1 = createTestD1();
  db = createDb(d1);
  handed = [];
  addressed = [];
});

describe("GET /api/computer-hosts/connect", () => {
  test("hands a good token's upgrade to that host's relay", async () => {
    const { host, token } = await createHost(db, {} as Env, "workspace-1", {
      config: {},
      kind: "self_hosted",
      name: "office-box",
    });

    const response = await upgrade(token);

    expect(response.status).toBe(101);
    expect(addressed).toEqual([host.id]);
    expect(handed).toEqual([
      {
        upgrade: "websocket",
        url: `http://localhost/hosts/${host.id}`,
      },
    ]);
  });

  test("refuses an unknown token, a missing one, and says nothing more", async () => {
    const [unknownToken, noHeader] = await Promise.all([
      upgrade("not-a-real-token"),
      upgrade(null),
    ]);

    expect([unknownToken.status, noHeader.status]).toEqual([401, 401]);
    const bodies = (await Promise.all([
      unknownToken.json(),
      noHeader.json(),
    ])) as unknown[];
    expect(bodies).toEqual([
      { error: "Unauthorized." },
      { error: "Unauthorized." },
    ]);
    expect(handed).toEqual([]);
  });

  test("refuses a token that resolves to a Fly host", async () => {
    // Nothing issues one today - a Fly host's token is stored encrypted, not
    // hashed, because Agentum is the side that presents it - so this is the
    // defensive half of the check, kept honest by writing the row by hand.
    await db.insert(computerHosts).values({
      config: {},
      id: "host-fly",
      kind: "fly",
      name: "fly-app",
      tokenHash: await hashMcpToken("fly-token"),
      workspaceId: "workspace-1",
    });

    const response = await upgrade("fly-token");

    expect(response.status).toBe(401);
    expect(handed).toEqual([]);
  });
});
