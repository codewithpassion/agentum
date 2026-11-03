/**
 * Pure helpers for agent-login.ts, which prints a Clerk Agent Task sign-in
 * URL. No I/O, no Clerk calls, no process or env access here. Tested in
 * agent-login.test.ts.
 */

export type AgentLoginEnv = "local" | "staging" | "preview" | "production";

// The spec fixes this as a type alias, so the interface-style rule is off here.
// biome-ignore lint/style/useConsistentTypeDefinitions: exported as a type alias by spec
export type AgentLoginArgs = {
  env: AgentLoginEnv;
  pr: number | undefined;
  email: string | undefined;
  redirect: string;
  baseUrl: string | undefined;
};

const ENVS: readonly AgentLoginEnv[] = [
  "local",
  "staging",
  "preview",
  "production",
];
const PR_NUMBER = /^\d+$/;
const LINE_BREAK = /\r?\n/;
const TRAILING_SLASHES = /\/+$/;
const LOCAL_BASE_URL = "http://localhost:3000";
const STAGING_BASE_URL = "https://staging.agentumbot.io";
const PRODUCTION_BASE_URL = "https://agentumbot.io";

const isAgentLoginEnv = (value: string): value is AgentLoginEnv =>
  (ENVS as readonly string[]).includes(value);

const stripTrailingSlashes = (url: string): string =>
  url.replace(TRAILING_SLASHES, "");

/** Parses the args after the script name. Throws on any invalid input. */
export const parseArgs = (argv: string[]): AgentLoginArgs => {
  let env: AgentLoginEnv = "local";
  let pr: number | undefined;
  let email: string | undefined;
  let redirect = "/";
  let baseUrl: string | undefined;

  let i = 0;
  const valueFor = (flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    i += 1;
    return value;
  };

  for (; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--env": {
        const value = valueFor(flag);
        if (!isAgentLoginEnv(value)) {
          throw new Error(
            `Invalid --env ${value}: use local, staging, preview or production.`
          );
        }
        env = value;
        break;
      }
      case "--pr": {
        const value = valueFor(flag);
        const number = Number(value);
        if (
          !(PR_NUMBER.test(value) && Number.isSafeInteger(number)) ||
          number < 1
        ) {
          throw new Error(`Invalid --pr ${value}: use a positive integer.`);
        }
        pr = number;
        break;
      }
      case "--email":
        email = valueFor(flag);
        break;
      case "--redirect": {
        const value = valueFor(flag);
        if (!value.startsWith("/")) {
          throw new Error(
            `Invalid --redirect ${value}: the path must start with "/".`
          );
        }
        redirect = value;
        break;
      }
      case "--base-url":
        baseUrl = valueFor(flag);
        break;
      default:
        throw new Error(`Unknown flag or argument: ${flag ?? ""}.`);
    }
  }

  if (env === "preview" && pr === undefined) {
    throw new Error("--env preview needs --pr <number>.");
  }
  if (env !== "preview" && pr !== undefined) {
    throw new Error("--pr only applies to --env preview.");
  }

  return { baseUrl, email, env, pr, redirect };
};

const BASE_URLS: Record<Exclude<AgentLoginEnv, "preview">, string> = {
  local: LOCAL_BASE_URL,
  production: PRODUCTION_BASE_URL,
  staging: STAGING_BASE_URL,
};

/** The app's origin for the given args. `--base-url` wins over the env. */
export const baseUrlFor = (args: AgentLoginArgs): string => {
  const override = args.baseUrl && stripTrailingSlashes(args.baseUrl);
  if (override) {
    return override;
  }
  if (args.env === "preview") {
    if (args.pr === undefined) {
      throw new Error("--env preview needs --pr <number>.");
    }
    return `https://pr-${args.pr}-harbourmaster-staging.dominik-fretz.workers.dev`;
  }
  return BASE_URLS[args.env];
};

export const redirectUrlFor = (args: AgentLoginArgs): string =>
  `${baseUrlFor(args)}${args.redirect}`;

const QUOTE_PAIR = /^(['"])(.*)\1$/;

const unquote = (value: string): string => {
  const match = value.match(QUOTE_PAIR);
  return match?.[2] ?? value;
};

/** Minimal dotenv: KEY=VALUE lines, blank lines and `#` comments skipped. */
export const parseEnvFile = (text: string): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const rawLine of text.split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    vars[key] = unquote(line.slice(eq + 1).trim());
  }
  return vars;
};

interface SecretSources {
  envLocal: Record<string, string | undefined>;
  process: Record<string, string | undefined>;
  productionLocal: Record<string, string | undefined>;
}

const usable = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Picks the Clerk secret key for the env. Local, staging and preview use the dev
 * key in apps/web/.env.local. Production uses its own Clerk instance, so it
 * takes the key file, or the process environment, which bun fills from
 * .env.local. A process value equal to the dev key is ignored.
 */
export const resolveSecretKey = (
  env: AgentLoginEnv,
  sources: SecretSources
): string => {
  const devKey = usable(sources.envLocal.CLERK_SECRET_KEY);
  if (env !== "production") {
    if (!devKey) {
      throw new Error(
        "CLERK_SECRET_KEY is missing or empty in apps/web/.env.local."
      );
    }
    return devKey;
  }

  const productionKey = usable(sources.productionLocal.CLERK_SECRET_KEY);
  if (productionKey) {
    return productionKey;
  }
  const processKey = usable(sources.process.CLERK_SECRET_KEY);
  if (processKey && processKey !== devKey) {
    return processKey;
  }
  throw new Error(
    "Production needs CLERK_SECRET_KEY in apps/web/.env.production.local or in the process environment."
  );
};
