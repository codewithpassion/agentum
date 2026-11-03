import { describe, expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import { importSecretsKey } from "@repo/services/crypto";
import { importRunTokenKey } from "@repo/services/run-tokens";
import {
  CYCLE_BREAKS,
  countMismatches,
  countQuery,
  cycleBreakQuery,
  DO_CLASSES,
  dataForImport,
  extraKeys,
  fillSecrets,
  migrationGap,
  newKey,
  nonEmptyTables,
  orderedImport,
  parentsFirst,
  parseMoveArgs,
  parseSecretNames,
  planCopy,
  type RoutingRule,
  repointedRule,
  rulesForWorker,
  SCRUB_STEPS,
  scrubCountQuery,
  scrubSql,
  secretsTemplate,
  transferConfig,
} from "./helpers.ts";

describe("parseMoveArgs", () => {
  test("needs --env and defaults to a dry run", () => {
    expect(parseMoveArgs(["--env", "staging"])).toEqual({
      apply: false,
      env: "staging",
    });
    expect(parseMoveArgs(["--apply", "--env", "production"])).toEqual({
      apply: true,
      env: "production",
    });
  });

  test("refuses a missing or unknown env and stray arguments", () => {
    expect(() => parseMoveArgs([])).toThrow("--env");
    expect(() => parseMoveArgs(["--env", "preview"])).toThrow("production");
    expect(() => parseMoveArgs(["--env", "staging", "--yes"])).toThrow(
      "Unknown"
    );
  });
});

const exportsMap = Object.fromEntries(
  DO_CLASSES.map((name) => [
    name,
    { storage: "sqlite", type: "durable-object" },
  ])
);

describe("transferConfig", () => {
  test("swaps exports for one transfer migration from the old Worker", () => {
    const out = transferConfig({
      containers: [{ class_name: "VmSession" }],
      exports: exportsMap,
      main: "index.js",
      migrations: [],
      name: "agentum-v2-staging",
    });
    expect(out.exports).toBeUndefined();
    expect(out.containers).toBeUndefined();
    expect(out.main).toBe("index.js");
    const [migration] = out.migrations as {
      tag: string;
      transferred_classes: { from: string; from_script: string; to: string }[];
    }[];
    expect(migration?.tag).toBe("v10");
    expect(migration?.transferred_classes).toHaveLength(DO_CLASSES.length);
    expect(migration?.transferred_classes[0]).toEqual({
      from: "MachineRelay",
      from_script: "harbourmaster-staging",
      to: "MachineRelay",
    });
  });

  test("production transfers from harbourmaster", () => {
    const out = transferConfig({ exports: exportsMap, name: "agentum-v2" });
    const migrations = out.migrations as {
      transferred_classes: { from_script: string }[];
    }[];
    const sources = migrations.flatMap((m) =>
      m.transferred_classes.map((t) => t.from_script)
    );
    expect(new Set(sources)).toEqual(new Set(["harbourmaster"]));
  });

  test("refuses another Worker, a changed class list or existing migrations", () => {
    expect(() =>
      transferConfig({ exports: exportsMap, name: "harbourmaster" })
    ).toThrow("not agentum-v2");
    expect(() =>
      transferConfig({ exports: { PiRun: {} }, name: "agentum-v2" })
    ).toThrow("expected");
    expect(() =>
      transferConfig({
        exports: exportsMap,
        migrations: [{ tag: "v1" }],
        name: "agentum-v2",
      })
    ).toThrow("already has migrations");
  });
});

const dataDump = [
  "PRAGMA defer_foreign_keys=TRUE;",
  `INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_init.sql');`,
  `INSERT INTO "agents" ("id","name") VALUES('a1','line one');`,
  "DELETE FROM sqlite_sequence;",
  `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);`,
].join("\n");

describe("D1 import", () => {
  test("parentsFirst puts every parent table before its children", () => {
    const keys = [
      { column: "workspace_id", parent: "workspaces", table: "agents" },
      { column: "agent_id", parent: "agents", table: "runs" },
      { column: "parent_run_id", parent: "runs", table: "runs" },
      { column: "run_id", parent: "runs", table: "artifacts" },
      { column: "scope_artifact_id", parent: "artifacts", table: "runs" },
    ];
    expect(
      parentsFirst(["artifacts", "runs", "agents", "workspaces"], keys)
    ).toEqual(["workspaces", "agents", "runs", "artifacts"]);
  });

  test("parentsFirst refuses a cycle CYCLE_BREAKS does not break", () => {
    expect(() =>
      parentsFirst(
        ["a", "b"],
        [
          { column: "b_id", parent: "b", table: "a" },
          { column: "a_id", parent: "a", table: "b" },
        ]
      )
    ).toThrow("cycle");
  });

  test("cycleBreakQuery counts the rows that use each break", () => {
    expect(CYCLE_BREAKS.length).toBeGreaterThan(0);
    expect(cycleBreakQuery()).toBe(
      `SELECT (SELECT count(*) FROM "runs" WHERE "scope_artifact_id" IS NOT NULL) AS "runs.scope_artifact_id";`
    );
  });

  test("orderedImport regroups the INSERTs and keeps sqlite_sequence last", () => {
    const data = [
      "PRAGMA defer_foreign_keys=TRUE;",
      `INSERT INTO "agents" ("id") VALUES('a1');`,
      `INSERT INTO "runs" ("id") VALUES('r1');`,
      `INSERT INTO "workspaces" ("id") VALUES('w1');`,
      `INSERT INTO "agents" ("id") VALUES('a2');`,
      "DELETE FROM sqlite_sequence;",
      `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);`,
    ].join("\n");
    expect(
      orderedImport(data, ["workspaces", "agents", "runs"]).split("\n")
    ).toEqual([
      "PRAGMA defer_foreign_keys=TRUE;",
      `INSERT INTO "workspaces" ("id") VALUES('w1');`,
      `INSERT INTO "agents" ("id") VALUES('a1');`,
      `INSERT INTO "agents" ("id") VALUES('a2');`,
      `INSERT INTO "runs" ("id") VALUES('r1');`,
      "DELETE FROM sqlite_sequence;",
      `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);`,
    ]);
  });

  test("dataForImport drops only the d1_migrations rows", () => {
    expect(dataForImport(dataDump).split("\n")).toEqual([
      "PRAGMA defer_foreign_keys=TRUE;",
      `INSERT INTO "agents" ("id","name") VALUES('a1','line one');`,
      "DELETE FROM sqlite_sequence;",
      `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',1);`,
    ]);
  });

  test("dataForImport refuses a dump with schema or without the pragma", () => {
    expect(() =>
      dataForImport(`${dataDump}\nCREATE TABLE \`x\` (id text);`)
    ).toThrow("--no-schema");
    expect(() =>
      dataForImport(dataDump.split("\n").slice(1).join("\n"))
    ).toThrow("PRAGMA");
  });

  test("migrationGap names migrations on one side only", () => {
    expect(migrationGap(["0000", "0001"], ["0000", "0002"])).toEqual([
      "only old: 0001",
      "only new: 0002",
    ]);
    expect(migrationGap(["0000"], ["0000"])).toEqual([]);
  });

  test("nonEmptyTables lists tables with rows", () => {
    expect(nonEmptyTables({ agents: 0, events: 3 })).toEqual(["events"]);
  });
});

describe("row counts", () => {
  test("countQuery counts every table in one row", () => {
    expect(countQuery(["agents", "events"])).toBe(
      'SELECT (SELECT count(*) FROM "agents") AS "agents", (SELECT count(*) FROM "events") AS "events";'
    );
  });

  test("countMismatches names the tables that differ", () => {
    expect(
      countMismatches({ agents: 2, events: 5 }, { agents: 2, events: 4 })
    ).toEqual(["events: 5 before, 4 after"]);
    expect(countMismatches({ agents: 1 }, {})).toEqual([
      "agents: 1 before, missing after",
    ]);
  });
});

describe("planCopy", () => {
  const source = [
    { key: "a", size: 1 },
    { key: "b", size: 2 },
    { key: "c", size: 3 },
  ];

  test("copies what is missing or changed, and only that", () => {
    expect(
      planCopy(source, [
        { key: "a", size: 1 },
        { key: "b", size: 9 },
      ]).map((entry) => entry.key)
    ).toEqual(["b", "c"]);
    expect(planCopy(source, source)).toEqual([]);
  });

  test("extraKeys lists keys only the target has", () => {
    expect(extraKeys(source, [...source, { key: "z", size: 1 }])).toEqual([
      "z",
    ]);
  });
});

describe("email rules", () => {
  const rule = (id: string, worker: string): RoutingRule => ({
    actions: [{ type: "worker", value: [worker] }],
    enabled: true,
    id,
    matchers: [{ field: "to", type: "literal", value: `${id}@x.io` }],
    name: `harbourmaster:${id}@x.io`,
    priority: 0,
  });

  test("selects by the action's Worker, not by the name prefix", () => {
    const rules = [
      rule("p", "harbourmaster"),
      rule("s", "harbourmaster-staging"),
      {
        ...rule("o", "harbourmaster"),
        actions: [{ type: "forward", value: ["me@x.io"] }],
      },
    ];
    expect(rulesForWorker(rules, "harbourmaster").map((r) => r.id)).toEqual([
      "p",
    ]);
    expect(
      rulesForWorker(rules, "harbourmaster-staging").map((r) => r.id)
    ).toEqual(["s"]);
  });

  test("repointedRule changes only the Worker and keeps the name", () => {
    expect(repointedRule(rule("p", "harbourmaster"), "agentum-v2")).toEqual({
      actions: [{ type: "worker", value: ["agentum-v2"] }],
      enabled: true,
      matchers: [{ field: "to", type: "literal", value: "p@x.io" }],
      name: "harbourmaster:p@x.io",
      priority: 0,
    });
  });
});

describe("secrets", () => {
  test("parseSecretNames reads names past wrangler's banner", () => {
    expect(
      parseSecretNames(
        'banner\n[{"name":"SECRETS_KEY","type":"secret_text"},{"name":"A","type":"secret_text"}]'
      )
    ).toEqual(["A", "SECRETS_KEY"]);
  });

  test("the template holds names only and marks the kept and rotated ones", () => {
    const text = secretsTemplate(
      ["A", "ARTIFACT_VIEW_KEY", "SECRETS_KEY"],
      "harbourmaster"
    );
    expect(text).toContain("\nA=\n");
    expect(text).toContain("or the copied data breaks.\nARTIFACT_VIEW_KEY=\n");
    expect(text).toContain(
      "written by scripts/migrate-v2/keys.ts.\nSECRETS_KEY=\n"
    );
  });

  test("a new key is 32 random bytes that both key importers accept", async () => {
    const key = newKey();
    expect(atob(key)).toHaveLength(32);
    expect(newKey()).not.toBe(key);
    await importSecretsKey(key);
    await importRunTokenKey(key);
  });

  test("fillSecrets fills empty lines and never replaces a value", () => {
    const file = secretsTemplate(
      ["A", "RUN_TOKEN_KEY", "SECRETS_KEY"],
      "harbourmaster"
    );
    const filled = fillSecrets(file, { RUN_TOKEN_KEY: "r", SECRETS_KEY: "s" });
    expect(filled).toContain("\nRUN_TOKEN_KEY=r\n");
    expect(filled).toContain("\nSECRETS_KEY=s\n");
    expect(filled).toContain("\nA=\n");
    expect(() => fillSecrets(filled, { SECRETS_KEY: "t" })).toThrow(
      "has a value already"
    );
    expect(() => fillSecrets(file, { MISSING: "x" })).toThrow("no MISSING=");
  });
});

describe("scrub", () => {
  const NOW = "2026-11-03T00:00:00.000Z";
  const WS = "ws_org_a";

  const counts = (db: ReturnType<typeof migrated>) =>
    db.client.query(scrubCountQuery()).get() as Record<string, number>;

  test("every statement runs on the current schema and leaves nothing to scrub", () => {
    const db = migrated(["org_a"]);
    db.client.run(scrubSql(NOW));
    expect(Object.values(counts(db)).every((n) => n === 0)).toBe(true);
    expect(Object.keys(counts(db))).toHaveLength(SCRUB_STEPS.length);
  });

  test("credentials need auth and sealed OAuth clients go, the shared one stays", () => {
    const db = migrated(["org_a"]);
    const oauth = (client: Record<string, unknown>) =>
      JSON.stringify({ client, tokenEndpoint: "https://t.example/token" });
    const insertConnector = db.client.prepare(
      "INSERT INTO connectors (id, workspace_id, name, url, auth_kind, status, created_by, created_at, oauth) VALUES (?, ?, ?, 'https://mcp.example', 'oauth', 'ok', 'u', ?, ?)"
    );
    insertConnector.run(
      "c_reg",
      WS,
      "registered",
      NOW,
      oauth({ clientId: "a", clientSecret: "v1:x:y", source: "registered" })
    );
    insertConnector.run(
      "c_man",
      WS,
      "manual",
      NOW,
      oauth({ clientId: "b", clientSecret: "v1:x:y", source: "manual" })
    );
    insertConnector.run(
      "c_pub",
      WS,
      "public client",
      NOW,
      oauth({ clientId: "c", clientSecret: null, source: "registered" })
    );
    insertConnector.run(
      "c_shared",
      WS,
      "google",
      NOW,
      oauth({ clientId: "d", clientSecret: "v1:x:y", source: "shared" })
    );
    db.client.run(
      `INSERT INTO credentials (id, workspace_id, connector_id, owner_id, owner_kind, secret, status, created_by, created_at, updated_at) VALUES ('cr1', '${WS}', 'c_reg', 'u', 'user', 'v1:x:y', 'ok', 'u', '${NOW}', '${NOW}'), ('cr2', '${WS}', 'c_man', 'u', 'user', 'v1:x:y', 'revoked', 'u', '${NOW}', '${NOW}')`
    );
    expect(counts(db)).toMatchObject({
      "connector credentials set to needs_auth": 1,
      "connector OAuth clients with a client secret removed": 2,
    });

    db.client.run(scrubSql(NOW));

    const clients = db.client
      .query(
        "SELECT id, json_extract(oauth, '$.client.clientId') AS client, json_extract(oauth, '$.tokenEndpoint') AS endpoint FROM connectors ORDER BY id"
      )
      .all();
    expect(clients).toEqual([
      { client: null, endpoint: "https://t.example/token", id: "c_man" },
      { client: "c", endpoint: "https://t.example/token", id: "c_pub" },
      { client: null, endpoint: "https://t.example/token", id: "c_reg" },
      { client: "d", endpoint: "https://t.example/token", id: "c_shared" },
    ]);
    expect(
      db.client
        .query("SELECT id, status, version FROM credentials ORDER BY id")
        .all()
    ).toEqual([
      { id: "cr1", status: "needs_auth", version: 2 },
      { id: "cr2", status: "revoked", version: 1 },
    ]);
  });
});
