#!/usr/bin/env bun
// One-off: rewrites Clerk org and user ids in the database from a mapping file
// (X.1, dev instance to the shared production instance). Dry run unless
// --apply. Usage, from apps/web:
//   bun scripts/migrate-clerk-ids.ts --map <file> --db <sqlite file> [--apply] [--invert]
//   bun scripts/migrate-clerk-ids.ts --map <file> --d1 DB [--remote] [--env staging] [--apply] [--invert]
// --db works on a local SQLite file, such as a copy of production D1. --d1
// works through wrangler: local Miniflare state by default, the real database
// with --remote. --invert swaps the mapping, to roll a migration back.
import { Database } from "bun:sqlite";
import { file, spawn, write } from "bun";
import {
  type Driver,
  parseMapping,
  run,
  sqliteDriver,
} from "./migrate-clerk-ids-helpers.ts";

const WRANGLER_CWD = `${import.meta.dir}/..`;

const wrangler = async (args: string[]): Promise<string> => {
  const proc = spawn(["bunx", "wrangler", ...args], {
    cwd: WRANGLER_CWD,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `wrangler ${args.slice(0, 3).join(" ")} failed:\n${out}${err}`
    );
  }
  return out;
};

const wranglerDriver = (
  binding: string,
  target: string[],
  scratch: string
): Driver => ({
  exec: async (statements) => {
    const path = `${scratch}/migrate-clerk-ids.sql`;
    await write(path, `${statements.join("\n")}\n`);
    await wrangler(["d1", "execute", binding, ...target, "--file", path, "-y"]);
  },
  select: async (statements) => {
    const out = await wrangler([
      "d1",
      "execute",
      binding,
      ...target,
      "--json",
      "--command",
      statements.join(";\n"),
    ]);
    const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
      results: Record<string, unknown>[];
    }[];
    return parsed.map((statement) => statement.results);
  },
});

const parseArgs = (argv: string[]) => {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (!flag.startsWith("--")) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const next = argv[i + 1];
    if (["--apply", "--invert", "--remote"].includes(flag)) {
      flags.set(flag, true);
    } else if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    } else {
      flags.set(flag, next);
      i += 1;
    }
  }
  return flags;
};

const main = async () => {
  const flags = parseArgs(process.argv.slice(2));
  const mapPath = flags.get("--map");
  const dbPath = flags.get("--db");
  const binding = flags.get("--d1");
  if (
    typeof mapPath !== "string" ||
    (typeof dbPath === "string") === (typeof binding === "string")
  ) {
    throw new Error(
      "Pass --map <file> and exactly one of --db <sqlite file> or --d1 <binding>."
    );
  }
  const idMap = parseMapping(
    await file(mapPath).text(),
    flags.get("--invert") === true
  );

  let driver: Driver;
  if (typeof dbPath === "string") {
    if (!(await file(dbPath).exists())) {
      throw new Error(`${dbPath} does not exist.`);
    }
    driver = sqliteDriver(new Database(dbPath));
  } else {
    const env = flags.get("--env");
    driver = wranglerDriver(
      String(binding),
      [
        flags.get("--remote") === true ? "--remote" : "--local",
        ...(typeof env === "string" ? ["--env", env] : []),
      ],
      process.env.TMPDIR ?? "/tmp"
    );
  }

  const result = await run(driver, idMap, flags.get("--apply") === true);
  console.log(result.report);
  process.exit(result.exitCode);
};

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "migrate-clerk-ids failed"
  );
  process.exit(1);
}
