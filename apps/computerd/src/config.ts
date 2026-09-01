/**
 * Everything the daemon needs comes from the environment, because the two ways
 * it runs - a Fly Machine created by Agentum, and a `docker run` a person typed
 * - can both only pass env vars. A missing or contradictory setting throws at
 * startup rather than failing on the first request.
 */

import { mkdir, realpath } from "node:fs/promises";

export type ComputerdMode = "connect" | "listen";

export interface ComputerdConfig {
  /** connect mode: the host token, presented once at connect time. */
  agentumToken: string;
  /** connect mode: the base URL of the Agentum deployment to dial. */
  agentumUrl: string;
  execMaxMs: number;
  mode: ComputerdMode;
  port: number;
  root: string;
  /** listen mode: SHA-256 of the token every request must present. */
  tokenHash: string;
}

const DEFAULT_ROOT = "/home/agent";
const DEFAULT_PORT = 8080;

/** Ten minutes: "run the test suite" is the point of having a real shell. */
const DEFAULT_MAX_EXEC_MS = 600_000;

const required = (env: Record<string, string | undefined>, name: string) => {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw?.trim()) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got "${raw}".`);
  }
  return value;
};

const readMode = (raw: string | undefined): ComputerdMode => {
  const value = raw?.trim() || "listen";
  if (value === "connect" || value === "listen") {
    return value;
  }
  throw new Error(
    `COMPUTERD_MODE must be "listen" or "connect", got "${raw}".`
  );
};

export const readConfig = (
  env: Record<string, string | undefined> = Bun.env
): ComputerdConfig => {
  const mode = readMode(env.COMPUTERD_MODE);
  return {
    agentumToken:
      mode === "connect" ? required(env, "AGENTUM_COMPUTER_TOKEN") : "",
    agentumUrl: mode === "connect" ? required(env, "AGENTUM_URL") : "",
    execMaxMs: positiveInt(env.COMPUTERD_MAX_EXEC_MS, DEFAULT_MAX_EXEC_MS),
    mode,
    port: positiveInt(env.COMPUTERD_PORT, DEFAULT_PORT),
    root: env.COMPUTERD_ROOT?.trim() || DEFAULT_ROOT,
    tokenHash: mode === "listen" ? required(env, "COMPUTERD_TOKEN_HASH") : "",
  };
};

/**
 * The root is compared against resolved paths, so it has to be the real one -
 * on a machine where `/home/agent` is itself a symlink, an unresolved root would
 * reject every request. Creating it first makes a bare-metal run work without a
 * prepared volume.
 */
export const prepareRoot = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true });
  return await realpath(root);
};
