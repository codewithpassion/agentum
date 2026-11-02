/**
 * Pure helpers for add-workspace.ts, which makes the first workspace row of a
 * deployment. No I/O, no Clerk calls, no process or env access here. Tested in
 * add-workspace.test.ts.
 */
import type { AgentLoginEnv } from "./agent-login-helpers.ts";

export interface AddWorkspaceArgs {
  /** Only `staging`, and only with `--remote`. Absent means the top-level (production) config. */
  env: "staging" | undefined;
  name: string;
  orgId: string;
  remote: boolean;
}

const ORG_ID = /^org_[A-Za-z0-9]+$/;
const USAGE =
  "Usage: bun run add-workspace --org <id> --name <name> (--local | --remote [--env staging])";

/** Parses the args after the script name. Throws on any invalid input. */
export const parseArgs = (argv: string[]): AddWorkspaceArgs => {
  let orgId: string | undefined;
  let name: string | undefined;
  let local = false;
  let remote = false;
  let env: string | undefined;

  let i = 0;
  const valueFor = (flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}. ${USAGE}`);
    }
    i += 1;
    return value;
  };

  for (; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--org":
        orgId = valueFor(flag);
        break;
      case "--name":
        name = valueFor(flag).trim();
        break;
      case "--env":
        env = valueFor(flag);
        break;
      case "--local":
        local = true;
        break;
      case "--remote":
        remote = true;
        break;
      default:
        throw new Error(`Unknown flag or argument: ${flag ?? ""}. ${USAGE}`);
    }
  }

  if (!(orgId && ORG_ID.test(orgId))) {
    throw new Error(
      `--org needs a Clerk organisation id like org_abc123. ${USAGE}`
    );
  }
  if (!name) {
    throw new Error(`--name needs a workspace name. ${USAGE}`);
  }
  if (local === remote) {
    throw new Error(`Pass exactly one of --local and --remote. ${USAGE}`);
  }
  if (env !== undefined && !remote) {
    throw new Error("--env only applies with --remote.");
  }
  if (env !== undefined && env !== "staging") {
    throw new Error(`Invalid --env ${env}: only staging.`);
  }
  return {
    env: env === "staging" ? "staging" : undefined,
    name,
    orgId,
    remote,
  };
};

/** The `wrangler d1 execute` flags that pick the database. */
export const wranglerTarget = (args: AddWorkspaceArgs): string[] => {
  if (!args.remote) {
    return ["--local"];
  }
  return args.env ? ["--remote", "--env", args.env] : ["--remote"];
};

/**
 * Which Clerk instance the organisation lives on. Local and staging use the
 * dev instance, production its own.
 */
export const clerkEnvFor = (args: AddWorkspaceArgs): AgentLoginEnv => {
  if (!args.remote) {
    return "local";
  }
  return args.env ?? "production";
};

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Inserts the row, and does nothing when the organisation already has one. */
export const insertSql = (input: {
  createdAt: string;
  id: string;
  name: string;
  orgId: string;
}): string =>
  `INSERT INTO workspaces (id, clerk_org_id, name, timezone, created_at) VALUES (${quote(input.id)}, ${quote(input.orgId)}, ${quote(input.name)}, 'UTC', ${quote(input.createdAt)}) ON CONFLICT (clerk_org_id) DO NOTHING`;

export const selectSql = (orgId: string): string =>
  `SELECT id, name FROM workspaces WHERE clerk_org_id = ${quote(orgId)}`;
