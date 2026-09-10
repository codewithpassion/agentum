import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { generateConnectorKey } from "#/crypto";
import { createDb, type Db } from "#/db/client";
import { signAttachmentLink } from "../attachment-links";
import { attachments } from "../schema";
import { attachmentLinkRoutes } from "./attachment-links";

/**
 * The public read route: no Clerk, no workspace prefix, and a signature as the
 * only credential.
 *
 * The assertion that matters most is not "does a good link work" but that every
 * bad one comes back *identical* - same status, same body. A route that answered
 * differently for "no such attachment" than for "wrong signature" would let an
 * unauthenticated caller enumerate which attachment ids exist, which is most of
 * what an attachment id is worth.
 */

const KEY = generateConnectorKey();
const TEXT_ID = "3f2a1b4c-0000-4000-8000-00000000000a";
const IMAGE_ID = "3f2a1b4c-0000-4000-8000-00000000000b";
const ORPHAN_ID = "3f2a1b4c-0000-4000-8000-00000000000c";
const UNKNOWN_ID = "3f2a1b4c-0000-4000-8000-0000000000ff";
const BODY = "the file's bytes";

const MIGRATIONS_DIR = new URL("../../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", MIGRATIONS_DIR), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
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

/** Only `get`, and only `body`: that is all the route asks of R2. */
const fakeBucket = (objects: Map<string, string>): R2Bucket =>
  ({
    get: (key: string) => {
      const value = objects.get(key);
      return Promise.resolve(value === undefined ? null : { body: value });
    },
  }) as unknown as R2Bucket;

const app = new Hono<{ Bindings: Env }>();
app.route("/api/attachment-links", attachmentLinkRoutes);

let db: Db;
let env: Env;

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  await db.insert(attachments).values([
    {
      filename: "notes.txt",
      id: TEXT_ID,
      mime: "text/plain",
      r2Key: `attachments/${TEXT_ID}`,
      size: BODY.length,
    },
    {
      filename: "chart.png",
      id: IMAGE_ID,
      mime: "image/png",
      r2Key: `attachments/${IMAGE_ID}`,
      size: BODY.length,
    },
    // A row whose R2 object is gone, which must refuse like everything else.
    {
      filename: "lost.txt",
      id: ORPHAN_ID,
      mime: "text/plain",
      r2Key: `attachments/${ORPHAN_ID}`,
      size: BODY.length,
    },
  ]);

  env = {
    ATTACHMENT_LINK_KEY: KEY,
    ATTACHMENTS: fakeBucket(
      new Map([
        [`attachments/${TEXT_ID}`, BODY],
        [`attachments/${IMAGE_ID}`, BODY],
      ])
    ),
    DB: d1,
  } as unknown as Env;
});

const linkTo = async (id: string, ttlSeconds?: number) => {
  const link = await signAttachmentLink(KEY, { id, ttlSeconds });
  return { exp: String(link.expiresAt), sig: link.signature };
};

const get = (
  id: string,
  query: { exp?: string; sig?: string },
  override?: Env
) => {
  const params = new URLSearchParams();
  if (query.exp !== undefined) {
    params.set("exp", query.exp);
  }
  if (query.sig !== undefined) {
    params.set("sig", query.sig);
  }
  const search = params.size > 0 ? `?${params}` : "";
  return app.request(
    `/api/attachment-links/${id}${search}`,
    {},
    override ?? env
  );
};

describe("a valid link", () => {
  test("streams the object with the same headers the authenticated route sets", async () => {
    const response = await get(TEXT_ID, await linkTo(TEXT_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe(String(BODY.length));
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="notes.txt"'
    );
    // Not the year-long immutable cache: this URL is meant to stop working.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(BODY);
  });

  test("serves an image inline, as the authenticated route does", async () => {
    const response = await get(IMAGE_ID, await linkTo(IMAGE_ID));

    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="chart.png"'
    );
  });

  test("needs no session: nothing here reads Clerk", async () => {
    // The whole point - an external service holds only the URL.
    const response = await get(TEXT_ID, await linkTo(TEXT_ID));

    expect(response.status).toBe(200);
  });
});

describe("every refusal is the same refusal", () => {
  test("unsigned, expired, tampered, unknown and missing all read alike", async () => {
    const good = await linkTo(TEXT_ID);
    const otherId = await linkTo(IMAGE_ID);
    const otherKey = await signAttachmentLink(generateConnectorKey(), {
      id: TEXT_ID,
    });
    const expired = await signAttachmentLink(KEY, {
      id: TEXT_ID,
      now: Date.now() - 3_600_000,
      ttlSeconds: 60,
    });
    const noKey = { ...env, ATTACHMENT_LINK_KEY: "" } as unknown as Env;

    const responses = await Promise.all([
      // Nothing signed at all.
      get(TEXT_ID, {}),
      get(TEXT_ID, { exp: good.exp }),
      get(TEXT_ID, { sig: good.sig }),
      // A signature that is not even base64url.
      get(TEXT_ID, { exp: good.exp, sig: "###" }),
      // Expiry moved forward, which is why the expiry is signed.
      get(TEXT_ID, { exp: String(Number(good.exp) + 86_400), sig: good.sig }),
      // Expiry that has passed.
      get(TEXT_ID, { exp: String(expired.expiresAt), sig: expired.signature }),
      // A real signature, pointed at a different attachment.
      get(TEXT_ID, otherId),
      // A real signature from a different deployment's key.
      get(TEXT_ID, {
        exp: String(otherKey.expiresAt),
        sig: otherKey.signature,
      }),
      // A correctly signed link to an id that does not exist...
      get(UNKNOWN_ID, await linkTo(UNKNOWN_ID)),
      // ...and to a row whose R2 object is gone.
      get(ORPHAN_ID, await linkTo(ORPHAN_ID)),
      // A perfectly good link, against a deployment that has no key: nothing
      // could have been signed, so nothing verifies.
      get(TEXT_ID, good, noKey),
    ]);

    const seen = await Promise.all(
      responses.map(async (response) => ({
        body: await response.text(),
        status: response.status,
      }))
    );
    const [first] = seen;
    if (!first) {
      throw new Error("expected a response for every case");
    }

    expect(first.status).toBe(404);
    // The oracle check: one distinguishable answer here and the route becomes a
    // way to test whether an attachment id exists.
    expect(seen).toEqual(seen.map(() => first));
  });
});
