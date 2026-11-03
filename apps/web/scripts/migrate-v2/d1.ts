#!/usr/bin/env bun
import { Database } from "bun:sqlite";
// Copies the old D1 database into the new one (docs/v3/agentum-v2-cutover.md).
// Dry run unless --apply. Usage, from apps/web:
//   bun scripts/migrate-v2/d1.ts --env staging|production [--apply]
// First run `wrangler d1 migrations apply DB --remote [--env staging]` so the
// new database has the schema. The script then checks both databases applied
// the same migrations and the new one is empty, exports the old one's rows
// (`--no-schema`, a read), and with --apply imports them and compares row
// counts table by table. Stop the old Worker's writes first, or rows written
// after the export are lost.
// Then it scrubs: the new Worker has a new SECRETS_KEY and RUN_TOKEN_KEY, so
// every value only the old keys could read goes to the state the app shows
// for a missing one (`SCRUB_STEPS` in helpers.ts). The dry run prints what
// the scrub would change, counted on the old database.
import { mkdir, readdir } from "node:fs/promises";
import { file, write } from "bun";
import {
  countMismatches,
  countQuery,
  cycleBreakQuery,
  dataForImport,
  FOREIGN_KEYS_QUERY,
  type ForeignKey,
  MIGRATIONS_QUERY,
  migrationGap,
  NAMES,
  nonEmptyTables,
  orderedImport,
  parentsFirst,
  parseMoveArgs,
  scrubCountQuery,
  scrubSql,
  TABLES_QUERY,
} from "./helpers.ts";
import { d1Rows, WORK_DIR, wrangler } from "./wrangler.ts";

const names = (rows: Record<string, unknown>[]) =>
  rows.map((row) => String(row.name));

const printScrub = (heading: string, row: Record<string, unknown>) => {
  console.log(heading);
  for (const [step, n] of Object.entries(row)) {
    console.log(`  ${String(n)} ${step}`);
  }
};

/** Clears what only the old keys could read, then checks nothing is left. */
const scrubEncrypted = async (database: string) => {
  printScrub(
    `Scrubbing ${database}:`,
    (await d1Rows(database, scrubCountQuery()))[0] ?? {}
  );
  const scrubFile = `${WORK_DIR}/${database}-scrub.sql`;
  await write(scrubFile, scrubSql(new Date().toISOString()));
  await wrangler([
    "d1",
    "execute",
    database,
    "--remote",
    "--file",
    scrubFile,
    "-y",
  ]);
  const left = Object.entries(
    (await d1Rows(database, scrubCountQuery()))[0] ?? {}
  ).filter(([, n]) => Number(n) > 0);
  if (left.length > 0) {
    throw new Error(
      `The scrub left rows behind: ${left.map(([step, n]) => `${String(n)} ${step}`).join(", ")}.`
    );
  }
  console.log("Scrubbed.");
};

const counts = async (database: string, tables: string[]) =>
  (await d1Rows(database, countQuery(tables)))[0] ?? {};

const MIGRATIONS_DIR = new URL(
  "../../../../packages/db/migrations/",
  import.meta.url
).pathname;

/**
 * An in-memory copy of the schema, built from the same migrations both
 * databases applied (the script checks that first). D1 refuses
 * `pragma_foreign_key_list`, so the foreign keys are read here instead.
 */
const localSchema = async (): Promise<Database> => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);"
  );
  const migrations = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const sources = await Promise.all(
    migrations.map((name) => file(`${MIGRATIONS_DIR}${name}`).text())
  );
  for (const source of sources) {
    db.exec(source.replaceAll("--> statement-breakpoint", ""));
  }
  return db;
};

/**
 * Loads the import file into the local schema with foreign keys checked on
 * every INSERT, not at commit. If that passes, no split D1 makes of the file
 * can put a child row before its parent. The export writes one statement per
 * line (`dataForImport`), and every line runs on its own, because one exec of
 * many statements can stop early without an error.
 */
const checkOrderLocally = (db: Database, data: string) => {
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("BEGIN;");
  const lines = data
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "");
  for (const [index, line] of lines.entries()) {
    try {
      db.run(line);
    } catch (error: unknown) {
      throw new Error(
        `The import order fails locally at statement ${index + 2}: ${line.slice(0, 80)}`,
        { cause: error }
      );
    }
  }
  db.exec("COMMIT;");
  console.log(
    `Local check: ${lines.length} statements load in order with foreign keys on.`
  );
};

const main = async () => {
  const { apply, env } = parseMoveArgs(process.argv.slice(2));
  const { oldD1, newD1 } = NAMES[env];

  const gap = migrationGap(
    names(await d1Rows(oldD1, MIGRATIONS_QUERY)),
    names(await d1Rows(newD1, MIGRATIONS_QUERY))
  );
  if (gap.length > 0) {
    throw new Error(
      `${oldD1} and ${newD1} applied different migrations:\n${gap.join("\n")}`
    );
  }
  const tables = names(await d1Rows(newD1, TABLES_QUERY));
  const full = nonEmptyTables(await counts(newD1, tables));
  if (full.length > 0) {
    throw new Error(`${newD1} is not empty: ${full.join(", ")}.`);
  }

  await mkdir(WORK_DIR, { recursive: true });
  const dump = `${WORK_DIR}/${oldD1}-data.sql`;
  await wrangler([
    "d1",
    "export",
    oldD1,
    "--remote",
    "--no-schema",
    "--output",
    dump,
  ]);
  const breaks = Object.entries(
    (await d1Rows(oldD1, cycleBreakQuery()))[0] ?? {}
  ).filter(([, n]) => Number(n) > 0);
  if (breaks.length > 0) {
    throw new Error(
      `Rows use a foreign key CYCLE_BREAKS leaves out of the order: ${breaks.map(([k, n]) => `${k} (${String(n)})`).join(", ")}.`
    );
  }
  const schema = await localSchema();
  const keys = schema.query(FOREIGN_KEYS_QUERY).all() as ForeignKey[];
  const data = orderedImport(
    dataForImport(await file(dump).text()),
    parentsFirst(tables, keys)
  );
  checkOrderLocally(schema, data);
  schema.close();
  const importFile = `${WORK_DIR}/${oldD1}-import.sql`;
  await write(importFile, data);
  const before = await counts(oldD1, tables);
  const rows = Object.values(before).reduce<number>(
    (sum, n) => sum + Number(n),
    0
  );
  console.log(
    `${oldD1}: ${tables.length} tables, ${rows} rows, exported to ${importFile}.`
  );

  if (!apply) {
    printScrub(
      `After the import, the scrub would change in ${newD1}:`,
      (await d1Rows(oldD1, scrubCountQuery()))[0] ?? {}
    );
    console.log(`Dry run. --apply imports it into ${newD1} and scrubs it.`);
    return;
  }
  await wrangler([
    "d1",
    "execute",
    newD1,
    "--remote",
    "--file",
    importFile,
    "-y",
  ]);
  const mismatches = countMismatches(before, await counts(newD1, tables));
  if (mismatches.length > 0) {
    throw new Error(
      `Row counts differ after the import:\n${mismatches.join("\n")}`
    );
  }
  console.log(`Imported. Row counts match in all ${tables.length} tables.`);
  await scrubEncrypted(newD1);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "d1 copy failed");
  process.exit(1);
}
