import { describe, expect, test } from "bun:test";
import {
  countMismatches,
  countQuery,
  DO_CLASSES,
  dataForImport,
  extraKeys,
  migrationGap,
  nonEmptyTables,
  parseMoveArgs,
  parseSecretNames,
  planCopy,
  type RoutingRule,
  repointedRule,
  rulesForWorker,
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
      exports: exportsMap,
      main: "index.js",
      migrations: [],
      name: "agentum-v2-staging",
    });
    expect(out.exports).toBeUndefined();
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

  test("the template holds names only and marks the must-keep ones", () => {
    const text = secretsTemplate(["A", "SECRETS_KEY"], "harbourmaster");
    expect(text).toContain("\nA=\n");
    expect(text).toContain("or the copied data breaks.\nSECRETS_KEY=\n");
  });
});
