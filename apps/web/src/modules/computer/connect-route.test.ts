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
const { createHost, issueEnrollmentCode, redeemEnrollmentCode } = await import(
  "./hosts"
);
const { computerConnectRoutes } = await import("./connect-route");
const { generateConnectorKey } = await import("#/crypto");

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
  const enrolledHost = async (kind: "fly" | "self_hosted" = "self_hosted") => {
    const { enrollmentCode, host } = await createHost(
      db,
      { CONNECTOR_KEY: generateConnectorKey() } as Env,
      "workspace-1",
      { config: kind === "fly" ? { app: "a" } : {}, kind, name: "office-box" }
    );
    // Fly hosts get no code; they enroll through a hand-issued one.
    const code = enrollmentCode ?? (await issueEnrollmentCode(db, host));
    const redeemed = await redeemEnrollmentCode(db, code);
    return { credential: redeemed?.credential ?? "", host };
  };

  test("hands an enrolled credential's upgrade to that host's relay", async () => {
    const { credential, host } = await enrolledHost();

    const response = await upgrade(credential);

    expect(response.status).toBe(101);
    expect(addressed).toEqual([host.id]);
    expect(handed).toEqual([
      {
        upgrade: "websocket",
        url: `http://localhost/hosts/${host.id}`,
      },
    ]);
  });

  test("accepts a Fly host's credential too", async () => {
    const { credential } = await enrolledHost("fly");

    expect((await upgrade(credential)).status).toBe(101);
  });

  test("refuses the enrollment code itself as a credential", async () => {
    const { enrollmentCode } = await createHost(db, {} as Env, "workspace-1", {
      config: {},
      kind: "self_hosted",
      name: "office-box",
    });

    expect((await upgrade(enrollmentCode)).status).toBe(401);
    expect(handed).toEqual([]);
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
});
