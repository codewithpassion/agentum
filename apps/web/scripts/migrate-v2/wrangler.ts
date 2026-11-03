// The wrangler calls the migrate-v2 CLIs share. Runs from apps/web, so wrangler
// picks up CLOUDFLARE_ACCOUNT_ID from .env.local and the repo's own version.
import { spawn } from "bun";

const APP_DIR = `${import.meta.dir}/../..`;

export const wrangler = async (args: string[]): Promise<string> => {
  const proc = spawn(["bunx", "wrangler", ...args], {
    cwd: APP_DIR,
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

/** Runs one read-only statement on a remote D1 database, by name. */
export const d1Rows = async (
  database: string,
  sql: string
): Promise<Record<string, unknown>[]> => {
  const out = await wrangler([
    "d1",
    "execute",
    database,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
    results: Record<string, unknown>[];
  }[];
  return parsed.at(0)?.results ?? [];
};

/** Where the CLIs keep dumps and templates. Gitignored with .wrangler. */
export const WORK_DIR = `${APP_DIR}/.wrangler/migrate-v2`;
