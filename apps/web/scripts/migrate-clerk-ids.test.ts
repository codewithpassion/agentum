/// <reference types="bun" />
import { beforeEach, describe, expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import {
  buildMapping,
  buildPlan,
  type ClerkLookup,
  discover,
  type Mapping,
  parseMapping,
  run,
  sqliteDriver,
} from "./migrate-clerk-ids-helpers.ts";

const OLD_ORG = "org_3KkfBN77ien6ryvH4YDBFjGNw0v";
const NEW_ORG = "org_3LDLbiYGe7iohEccrRQuLeBqaX2";
const OLD_USER = "user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m";
const NEW_USER = "user_3LDMnewUserIdProdInstance01";
const WS = "01M5TXYDGQGMVK6BFFWA6MNDXD";
const NOW = "2026-10-26T01:42:05.079Z";

const mapping = JSON.stringify({
  orgs: { [OLD_ORG]: { id: NEW_ORG, name: "Harbour Edge Intelligence" } },
  users: { [OLD_USER]: { email: "a@b.co", id: NEW_USER } },
});
const idMap: Mapping = parseMapping(mapping);

// A Clerk-shaped id: prefix plus 27 base62 characters.
const mk = (prefix: "org" | "user", tag: string) =>
  `${prefix}_${tag.padEnd(27, "0")}`;

let db: ReturnType<typeof migrated>;

const seed = () => {
  db.run(
    `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone) VALUES ('${OLD_ORG}', '${NOW}', '${WS}', '${OLD_ORG}', 'UTC')`
  );
  db.run(
    `INSERT INTO oauth_clients (client_id, created_at, first_seen_by, id, workspace_id) VALUES ('c1', '${NOW}', '${OLD_USER}', 'oc1', '${WS}')`
  );
  for (const [id, actor, kind, payload] of [
    [
      "e1",
      OLD_USER,
      "user",
      `{"principal":{"userId":"${OLD_USER}","via":"session"}}`,
    ],
    ["e2", "01M5TXZT63W8M2C09XRKNW9CCZ", "agent", "{}"],
  ] as const) {
    db.run(
      `INSERT INTO events (actor_id, actor_kind, created_at, id, payload, type, workspace_id) VALUES ('${actor}', '${kind}', '${NOW}', '${id}', '${payload}', 't', '${WS}')`
    );
  }
};

const triggers = () =>
  db.client
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
    )
    .all();

const dump = () =>
  JSON.stringify([
    db.client.query("SELECT * FROM workspaces").all(),
    db.client.query("SELECT * FROM oauth_clients").all(),
    db.client.query("SELECT * FROM events ORDER BY id").all(),
  ]);

beforeEach(() => {
  db = migrated();
  seed();
});

describe("parseMapping", () => {
  test("reads objects and plain strings, and inverts", () => {
    const plain = parseMapping(
      JSON.stringify({ orgs: { [mk("org", "a")]: mk("org", "b") }, users: {} })
    );
    expect(plain.ids.get(mk("org", "a"))).toBe(mk("org", "b"));
    expect(idMap.ids.get(OLD_USER)).toBe(NEW_USER);
    expect(parseMapping(mapping, true).ids.get(NEW_ORG)).toBe(OLD_ORG);
  });

  test("rejects bad ids, self maps, duplicates and chains", () => {
    const parse = (value: unknown) => () => parseMapping(JSON.stringify(value));
    expect(
      parse({ orgs: { [mk("user", "a")]: mk("org", "b") }, users: {} })
    ).toThrow();
    expect(
      parse({ orgs: {}, users: { [mk("user", "a")]: mk("user", "a") } })
    ).toThrow();
    expect(
      parse({
        orgs: {},
        users: { [`${mk("user", "a")}'; --`]: mk("user", "b") },
      })
    ).toThrow();
    expect(
      parse({
        orgs: {},
        users: {
          [mk("user", "a")]: mk("user", "c"),
          [mk("user", "b")]: mk("user", "c"),
        },
      })
    ).toThrow();
    expect(
      parse({
        orgs: {},
        users: {
          [mk("user", "a")]: mk("user", "b"),
          [mk("user", "b")]: mk("user", "c"),
        },
      })
    ).toThrow();
    expect(parse({ orgs: {} })).toThrow();
  });
});

describe("dry run", () => {
  test("lists every cell it would change and writes nothing", async () => {
    const before = dump();
    const result = await run(sqliteDriver(db.client), idMap, false);
    expect(result.exitCode).toBe(0);
    for (const line of [
      `workspaces  ${WS}  clerk_org_id  ${OLD_ORG} -> ${NEW_ORG}`,
      `workspaces  ${WS}  name  ${OLD_ORG} -> ${NEW_ORG}`,
      `oauth_clients  oc1  first_seen_by  ${OLD_USER} -> ${NEW_USER}`,
      `events  e1  actor_id  ${OLD_USER} -> ${NEW_USER}`,
      `events  e1  payload  ${OLD_USER} -> ${NEW_USER}`,
    ]) {
      expect(result.report).toContain(line);
    }
    expect(result.report).not.toContain("e2");
    expect(result.report).toContain("5 cell(s) in 3 row(s) of 3 table(s)");
    expect(dump()).toBe(before);
  });

  test("finds ids in a column of a table it has never heard of", async () => {
    db.run("CREATE TABLE later (id TEXT, note TEXT, n INTEGER)");
    db.run(`INSERT INTO later VALUES ('l1', 'asked by ${OLD_USER}.', 1)`);
    const { occurrences } = await discover(sqliteDriver(db.client));
    expect(occurrences).toContainEqual({
      column: "note",
      key: "l1",
      table: "later",
      token: OLD_USER,
    });
  });

  test("an id it has no mapping for is reported and blocks the run", async () => {
    db.run(
      `INSERT INTO oauth_clients (client_id, created_at, first_seen_by, id, workspace_id) VALUES ('c2', '${NOW}', 'user_3ZZZstrangerxxxxxxxxxxxxxxx', 'oc2', '${WS}')`
    );
    const dry = await run(sqliteDriver(db.client), idMap, false);
    expect(dry.exitCode).toBe(1);
    expect(dry.report).toContain(
      "UNMAPPED  oauth_clients  oc2  first_seen_by  user_3ZZZstrangerxxxxxxxxxxxxxxx"
    );
    const before = dump();
    const applied = await run(sqliteDriver(db.client), idMap, true);
    expect(applied.exitCode).toBe(1);
    expect(dump()).toBe(before);
  });

  test("two workspaces for one org block the run", async () => {
    db.run(
      `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone) VALUES ('${NEW_ORG}', '${NOW}', 'ws2', 'x', 'UTC')`
    );
    const result = await run(sqliteDriver(db.client), idMap, true);
    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("Delete the stray");
  });
});

describe("apply", () => {
  test("leaves no old id behind and keeps events append-only", async () => {
    const triggersBefore = triggers();
    expect(triggersBefore).toHaveLength(2);
    const result = await run(sqliteDriver(db.client), idMap, true);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("Verified");

    expect(dump()).not.toContain(OLD_ORG);
    expect(dump()).not.toContain(OLD_USER);
    expect(
      db.client.query("SELECT clerk_org_id, name FROM workspaces").get()
    ).toEqual({
      clerk_org_id: NEW_ORG,
      name: NEW_ORG,
    });
    const payload = db.client
      .query("SELECT payload FROM events WHERE id = 'e1'")
      .get() as {
      payload: string;
    };
    expect(JSON.parse(payload.payload)).toEqual({
      principal: { userId: NEW_USER, via: "session" },
    });
    // The agent's actor id is not a Clerk id and stays.
    expect(
      db.client.query("SELECT actor_id FROM events WHERE id = 'e2'").get()
    ).toEqual({
      actor_id: "01M5TXZT63W8M2C09XRKNW9CCZ",
    });

    expect(triggers()).toEqual(triggersBefore);
    expect(() => db.client.run("UPDATE events SET type = 'x'")).toThrow(
      "events is append-only"
    );
    expect(() => db.client.run("DELETE FROM events")).toThrow(
      "events is append-only"
    );
  });

  test("a second run finds nothing to change", async () => {
    await run(sqliteDriver(db.client), idMap, true);
    const again = await run(sqliteDriver(db.client), idMap, true);
    expect(again.exitCode).toBe(0);
    expect(again.report).toContain("Nothing to change");
    expect(again.report).toContain("0 cell(s)");
  });

  test("the inverted mapping puts the old ids back", async () => {
    const before = dump();
    await run(sqliteDriver(db.client), idMap, true);
    const back = await run(
      sqliteDriver(db.client),
      parseMapping(mapping, true),
      true
    );
    expect(back.exitCode).toBe(0);
    expect(dump()).toBe(before);
  });

  test("a failed write rolls back, triggers included", async () => {
    const driver = sqliteDriver(db.client);
    const { occurrences } = await discover(driver);
    const { statements } = buildPlan(occurrences, idMap);
    // The unique index on workspaces.clerk_org_id fails the last UPDATE, after
    // the events triggers are dropped and events is rewritten.
    db.client.run(
      `INSERT INTO workspaces (clerk_org_id, created_at, id, name, timezone) VALUES ('${NEW_ORG}', '${NOW}', 'ws2', 'x', 'UTC')`
    );
    const before = dump();
    const triggersBefore = triggers();
    await expect(driver.exec(statements)).rejects.toThrow();
    expect(dump()).toBe(before);
    expect(triggers()).toEqual(triggersBefore);
  });

  test("the sql only touches the triggers when events changes", async () => {
    const { occurrences } = await discover(sqliteDriver(db.client));
    const plan = buildPlan(
      occurrences.filter((o) => o.table !== "events"),
      idMap
    );
    expect(plan.statements.join("\n")).toContain("UPDATE");
    expect(plan.statements.join("\n")).not.toContain("TRIGGER");
  });
});

const fakeLookup = (): ClerkLookup => ({
  emailOf: (id) => Promise.resolve(id === OLD_USER ? "A@B.co" : undefined),
  nameOf: (id) => Promise.resolve(id === OLD_ORG ? "HEI" : undefined),
  orgIdsByName: (name) => Promise.resolve(name === "HEI" ? [NEW_ORG] : []),
  userIdsByEmail: (email) =>
    Promise.resolve(email === "a@b.co" ? [NEW_USER] : []),
});

describe("buildMapping", () => {
  test("matches users by email and orgs by name, and lists what it can't", async () => {
    const lookup = fakeLookup();
    const result = await buildMapping(
      [OLD_USER, OLD_ORG, OLD_USER, mk("user", "gone"), mk("org", "gone")],
      lookup,
      lookup
    );
    expect(result.mapping).toEqual({
      orgs: { [OLD_ORG]: { id: NEW_ORG, name: "HEI" } },
      users: { [OLD_USER]: { email: "a@b.co", id: NEW_USER } },
    });
    expect(result.unresolved).toEqual([
      `${mk("org", "gone")} (not found on the old instance)`,
      `${mk("user", "gone")} (not found on the old instance)`,
    ]);
    // What it writes is what the migration reads.
    expect(parseMapping(JSON.stringify(result.mapping)).ids.get(OLD_USER)).toBe(
      NEW_USER
    );
  });

  test("two matches on the production side are not guessed between", async () => {
    const lookup = {
      ...fakeLookup(),
      userIdsByEmail: () => Promise.resolve([mk("user", "x"), mk("user", "y")]),
    };
    const result = await buildMapping([OLD_USER], lookup, lookup);
    expect(result.mapping.users).toEqual({});
    expect(result.unresolved[0]).toContain("2 user(s) with a@b.co");
  });
});

const BRAIN_USER = "user_3FOGAZYIi6P6jPMEIOdR8XQ7MQ7";

describe("what counts as a Clerk id", () => {
  const seedLookalikes = () => {
    db.client.run(
      `INSERT INTO events (actor_id, actor_kind, created_at, id, payload, type, workspace_id) VALUES ('${BRAIN_USER}', 'x', '${NOW}', 'e3', '{"user":"${BRAIN_USER}"}', 't', '${WS}')`
    );
    db.client.run("CREATE TABLE later (id TEXT, a TEXT, b TEXT, c TEXT)");
    db.client.run(
      `INSERT INTO later VALUES ('l1', 'user_or_agent', 'https://brain.example/mcp/org_user_3FOGDavhnVCao6o4ZrfQArZ7Khb', 'x${OLD_USER}y')`
    );
  };

  test("user_or_agent, org_user_<id> paths and ids inside longer words are not ids", async () => {
    seedLookalikes();
    const { occurrences } = await discover(sqliteDriver(db.client));
    const later = occurrences.filter((o) => o.table === "later");
    expect(later).toEqual([]);
    // The brain's own id has Clerk's shape, so it is found.
    expect(occurrences.map((o) => o.token)).toContain(BRAIN_USER);
  });

  test("a mapping file can't map or ignore something that isn't a Clerk id", () => {
    for (const bad of [
      { orgs: { org_user: "org_user" }, users: {} },
      { orgs: {}, users: { user_or: mk("user", "a") } },
      { ignore: ["user_or"], orgs: {}, users: {} },
      { ignore: [OLD_USER], orgs: {}, users: { [OLD_USER]: NEW_USER } },
    ]) {
      expect(() => parseMapping(JSON.stringify(bad))).toThrow();
    }
  });

  test("an ignored foreign id blocks nothing and is left as it is", async () => {
    seedLookalikes();
    const without = await run(sqliteDriver(db.client), idMap, true);
    expect(without.exitCode).toBe(1);
    expect(without.report).toContain(
      `UNMAPPED  events  e3  actor_id  ${BRAIN_USER}`
    );

    const withIgnore = parseMapping(
      JSON.stringify({ ...JSON.parse(mapping), ignore: [BRAIN_USER] })
    );
    const dry = await run(sqliteDriver(db.client), withIgnore, false);
    expect(dry.exitCode).toBe(0);
    expect(dry.report).toContain("2 ignored");
    const applied = await run(sqliteDriver(db.client), withIgnore, true);
    expect(applied.exitCode).toBe(0);
    expect(
      db.client
        .query("SELECT actor_id, payload FROM events WHERE id = 'e3'")
        .get()
    ).toEqual({
      actor_id: BRAIN_USER,
      payload: `{"user":"${BRAIN_USER}"}`,
    });
    expect(db.client.query("SELECT a, b, c FROM later").get()).toEqual({
      a: "user_or_agent",
      b: "https://brain.example/mcp/org_user_3FOGDavhnVCao6o4ZrfQArZ7Khb",
      c: `x${OLD_USER}y`,
    });
  });

  test("the builder skips ignored ids and can ignore what it can't resolve", async () => {
    const lookup = fakeLookup();
    const ids = [OLD_USER, BRAIN_USER, mk("org", "gone")];
    const kept = await buildMapping(ids, lookup, lookup, {
      ignore: [BRAIN_USER],
    });
    expect(kept.mapping.ignore).toEqual([BRAIN_USER]);
    expect(kept.unresolved).toEqual([
      `${mk("org", "gone")} (not found on the old instance)`,
    ]);

    const all = await buildMapping(ids, lookup, lookup, {
      ignore: [BRAIN_USER],
      ignoreUnresolved: true,
    });
    expect(all.unresolved).toEqual([]);
    expect(all.ignored).toEqual([
      `${mk("org", "gone")} (not found on the old instance)`,
    ]);
    expect(all.mapping.ignore).toEqual([BRAIN_USER, mk("org", "gone")].sort());
    expect(
      parseMapping(JSON.stringify(all.mapping)).ignore.has(BRAIN_USER)
    ).toBe(true);
  });

  test("--ignore-unresolved never hides an id that exists on dev", async () => {
    // On dev, found by email, but nobody with that email on production.
    const lookup = {
      ...fakeLookup(),
      userIdsByEmail: () => Promise.resolve([]),
    };
    const result = await buildMapping([OLD_USER], lookup, lookup, {
      ignoreUnresolved: true,
    });
    expect(result.mapping.ignore).toBeUndefined();
    expect(result.ignored).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
  });

  test("an id joined to other characters by _ is not an id", async () => {
    db.client.run("CREATE TABLE later (id TEXT, a TEXT)");
    db.client.run(
      `INSERT INTO later VALUES ('l1', 'oat_${OLD_USER}_c1 ${OLD_ORG}_x')`
    );
    const { occurrences } = await discover(sqliteDriver(db.client));
    expect(occurrences.filter((o) => o.table === "later")).toEqual([]);
  });
});
