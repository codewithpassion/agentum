#!/usr/bin/env bun
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
import { mkdir } from "node:fs/promises";
import { file, write } from "bun";
import {
  countMismatches,
  countQuery,
  dataForImport,
  MIGRATIONS_QUERY,
  migrationGap,
  NAMES,
  nonEmptyTables,
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
  const data = dataForImport(await file(dump).text());
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
