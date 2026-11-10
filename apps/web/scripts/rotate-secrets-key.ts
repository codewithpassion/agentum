#!/usr/bin/env bun
// Re-encrypts every value stored under the previous SECRETS_KEY with the
// current one (SE.4). Dry run unless --apply. The runbook is
// docs/key-rotation.md. The keys come from the environment, never from flags,
// so they stay out of shell history and process lists. They have their own
// names because bun loads apps/web/.env and .env.local, which define
// SECRETS_KEY for local dev: a key read from there would be the wrong one.
//   NEW_SECRETS_KEY=<new> OLD_SECRETS_KEY=<old> bun run rotate-secrets-key (--local | --remote [--env staging]) [--apply]
// --local works on Miniflare's state, --remote on the real D1 database.
import { spawn, write } from "bun";
import { type Driver, run } from "./rotate-secrets-key-helpers.ts";

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

const wranglerDriver = (target: string[], scratch: string): Driver => ({
  exec: async (statements) => {
    const path = `${scratch}/rotate-secrets-key.sql`;
    await write(path, `${statements.join("\n")}\n`);
    await wrangler(["d1", "execute", "DB", ...target, "--file", path, "-y"]);
  },
  select: async (sql) => {
    const out = await wrangler([
      "d1",
      "execute",
      "DB",
      ...target,
      "--json",
      "--command",
      sql,
    ]);
    const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
      results: Record<string, unknown>[];
    }[];
    return parsed.flatMap((statement) => statement.results);
  },
});

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
  return flags;
};

const main = async () => {
  const flags = parseArgs(process.argv.slice(2));
  const current = process.env.NEW_SECRETS_KEY?.trim();
  const previous = process.env.OLD_SECRETS_KEY?.trim();
  if (!(current && previous)) {
    throw new Error(
      "Set NEW_SECRETS_KEY (the new key) and OLD_SECRETS_KEY (the old key) in the environment."
    );
  }
  if (current === previous) {
    throw new Error("NEW_SECRETS_KEY and OLD_SECRETS_KEY are the same key.");
  }
  const env = flags.get("--env");
  const driver = wranglerDriver(
    [
      flags.has("--remote") ? "--remote" : "--local",
      ...(typeof env === "string" ? ["--env", env] : []),
    ],
    process.env.TMPDIR ?? "/tmp"
  );
  const result = await run(
    driver,
    { current, previous },
    flags.get("--apply") === true
  );
  console.log(result.report);
  process.exit(result.exitCode);
};

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "rotate-secrets-key failed"
  );
  process.exit(1);
}
