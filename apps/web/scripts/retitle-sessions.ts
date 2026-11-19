#!/usr/bin/env bun
// bun run retitle-sessions (--local | --remote [--env staging]) [--apply]
// Dry run by default; only --apply writes the repair plan.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, write } from "bun";
import {
  planRetitles,
  type RetitleRow,
  SELECT_SESSIONS,
} from "./retitle-sessions-helpers.ts";

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

const parseArgs = (argv: string[]) => {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (["--apply", "--local", "--remote"].includes(flag)) {
      flags.set(flag, true);
    } else if (flag === "--env" && argv[i + 1]) {
      flags.set(flag, argv[i + 1] ?? "");
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (flags.has("--local") === flags.has("--remote")) {
    throw new Error("Pass exactly one of --local or --remote.");
  }
  if (
    flags.has("--env") &&
    (!flags.has("--remote") || flags.get("--env") !== "staging")
  ) {
    throw new Error("--env staging is supported only with --remote.");
  }
  return flags;
};

const main = async () => {
  const flags = parseArgs(process.argv.slice(2));
  const env = flags.get("--env");
  const target = [
    flags.has("--remote") ? "--remote" : "--local",
    ...(typeof env === "string" ? ["--env", env] : []),
  ];
  const out = await wrangler([
    "d1",
    "execute",
    "DB",
    ...target,
    "--json",
    "--command",
    SELECT_SESSIONS,
  ]);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
    results: RetitleRow[];
  }[];
  const plan = planRetitles(parsed.flatMap((statement) => statement.results));
  const apply = flags.has("--apply");
  console.log(apply ? "Applying title repairs:" : "Dry run:");
  for (const update of plan.updates) {
    // Escape control characters so every repair prints on one readable line.
    console.log(
      `${update.id}: ${JSON.stringify(update.oldTitle)} -> ${update.newTitle}`
    );
  }
  if (apply && plan.statements.length > 0) {
    const scratch = await mkdtemp(join(tmpdir(), "retitle-sessions-"));
    try {
      const path = join(scratch, "retitle-sessions.sql");
      for (let i = 0; i < plan.statements.length; i += 200) {
        // biome-ignore lint/performance/noAwaitInLoops: bounded batches, one wrangler process at a time
        await write(path, `${plan.statements.slice(i, i + 200).join("\n")}\n`);
        await wrangler([
          "d1",
          "execute",
          "DB",
          ...target,
          "--file",
          path,
          "-y",
        ]);
      }
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  }
  console.log(
    `${plan.updates.length} repairs planned.${apply ? "" : " Nothing written. Run again with --apply."}`
  );
};

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "retitle-sessions failed"
  );
  process.exit(1);
}
