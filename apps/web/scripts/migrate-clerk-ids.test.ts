/// <reference types="bun" />
import { beforeEach, describe, expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import {
  buildMapping,
  buildPlan,
  type ClerkLookup,
  discover,
  type IdMap,
  parseMapping,
  run,
  sqliteDriver,
} from "./migrate-clerk-ids-helpers.ts";

const OLD_ORG = "org_3KkfBN77ien6ryvH4YDBFjGNw0v";
const NEW_ORG = "org_3LDLbiYGe7iohEccrRQuLeBqaX2";
const OLD_USER = "user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m";
const NEW_USER = "user_3LDMnewUserIdForTheProdInstance";
const WS = "01M5TXYDGQGMVK6BFFWA6MNDXD";
const NOW = "2026-10-26T01:42:05.079Z";

const mapping = JSON.stringify({
  orgs: { [OLD_ORG]: { id: NEW_ORG, name: "Harbour Edge Intelligence" } },
  users: { [OLD_USER]: { email: "a@b.co", id: NEW_USER } },
});
const idMap: IdMap = parseMapping(mapping);

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
      JSON.stringify({ orgs: { org_a: "org_b" }, users: {} })
    );
    expect(plain.get("org_a")).toBe("org_b");
    expect(idMap.get(OLD_USER)).toBe(NEW_USER);
    expect(parseMapping(mapping, true).get(NEW_ORG)).toBe(OLD_ORG);
  });

  test("rejects bad ids, self maps, duplicates and chains", () => {
    const parse = (value: unknown) => () => parseMapping(JSON.stringify(value));
    expect(parse({ orgs: { user_a: "org_b" }, users: {} })).toThrow();
    expect(parse({ orgs: {}, users: { user_a: "user_a" } })).toThrow();
    expect(parse({ orgs: {}, users: { "user_a'; --": "user_b" } })).toThrow();
    expect(
      parse({ orgs: {}, users: { user_a: "user_c", user_b: "user_c" } })
    ).toThrow();
    expect(
      parse({ orgs: {}, users: { user_a: "user_b", user_b: "user_c" } })
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
      `INSERT INTO oauth_clients (client_id, created_at, first_seen_by, id, workspace_id) VALUES ('c2', '${NOW}', 'user_3ZZZstranger', 'oc2', '${WS}')`
    );
    const dry = await run(sqliteDriver(db.client), idMap, false);
    expect(dry.exitCode).toBe(1);
    expect(dry.report).toContain(
      "UNMAPPED  oauth_clients  oc2  first_seen_by  user_3ZZZstranger"
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
      [OLD_USER, OLD_ORG, OLD_USER, "user_gone", "org_gone"],
      lookup,
      lookup
    );
    expect(result.mapping).toEqual({
      orgs: { [OLD_ORG]: { id: NEW_ORG, name: "HEI" } },
      users: { [OLD_USER]: { email: "a@b.co", id: NEW_USER } },
    });
    expect(result.unresolved).toEqual([
      "org_gone (not found on the dev instance)",
      "user_gone (not found on the dev instance)",
    ]);
    // What it writes is what the migration reads.
    expect(parseMapping(JSON.stringify(result.mapping)).get(OLD_USER)).toBe(
      NEW_USER
    );
  });

  test("two matches on the production side are not guessed between", async () => {
    const lookup = {
      ...fakeLookup(),
      userIdsByEmail: () => Promise.resolve(["user_x", "user_y"]),
    };
    const result = await buildMapping([OLD_USER], lookup, lookup);
    expect(result.mapping.users).toEqual({});
    expect(result.unresolved[0]).toContain("2 user(s) with a@b.co");
  });
});
