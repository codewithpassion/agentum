import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Db } from "#/db/client";

/**
 * The enrollment endpoint. It is outside `requireAuth`, so the code is the
 * only credential - and a caller may learn nothing from a failure except that
 * it failed.
 */

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { createDb } = await import("#/db/client");
const { createHost, findHostByToken } = await import("./hosts");
const { computerEnrollments } = await import("./schema");
const { eq } = await import("drizzle-orm");
const { computerEnrollRoutes } = await import("./enroll-route");

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
app.route("/api/computer-hosts", computerEnrollRoutes);

let d1: D1Database;
let db: Db;

const enroll = async (body: unknown): Promise<Response> =>
  await app.request(
    "/api/computer-hosts/enroll",
    {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
    { DB: d1 } as unknown as Env
  );

const clientBody = (code: string) => ({
  arch: "arm64",
  enrollment_code: code,
  hostname: "office-box",
  os: "linux",
  version: "0.1.0",
});

const newHost = async (name = "office-box") => {
  const { enrollmentCode, host } = await createHost(
    db,
    {} as Env,
    "workspace-1",
    {
      config: {},
      kind: "self_hosted",
      name,
    }
  );
  return { code: enrollmentCode ?? "", host };
};

beforeEach(() => {
  d1 = createTestD1();
  db = createDb(d1);
});

describe("POST /api/computer-hosts/enroll", () => {
  test("trades a code for a credential that names the host", async () => {
    const { code, host } = await newHost();

    const response = await enroll(clientBody(code));

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { computer_id: string; machine_credential: string };
    };
    expect(data.computer_id).toBe(host.id);
    expect((await findHostByToken(db, data.machine_credential))?.id).toBe(
      host.id
    );
  });

  test("a wrong, expired, reused or malformed code all get the identical 401", async () => {
    const { code } = await newHost();
    const expired = await newHost("expired-box");
    await db
      .update(computerEnrollments)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(computerEnrollments.hostId, expired.host.id));
    await enroll(clientBody(code));

    const responses = await Promise.all([
      enroll(clientBody("not-a-code")),
      enroll(clientBody(expired.code)),
      enroll(clientBody(code)),
      enroll("not json"),
      enroll({ hostname: "x" }),
    ]);

    const seen = await Promise.all(
      responses.map(async (r) => [r.status, await r.text()] as const)
    );
    expect(seen.map(([status]) => status)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(seen.map(([, text]) => text)).size).toBe(1);
  });

  test("two concurrent redemptions: exactly one wins", async () => {
    const { code, host } = await newHost();

    const [a, b] = await Promise.all([
      enroll(clientBody(code)),
      enroll(clientBody(code)),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const winner = (await (a.status === 200 ? a : b).json()) as {
      data: { machine_credential: string };
    };
    // The stored credential is the winner's.
    expect(
      (await findHostByToken(db, winner.data.machine_credential))?.id
    ).toBe(host.id);
  });
});
