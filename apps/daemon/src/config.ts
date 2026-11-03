// The daemon's on-disk config, `~/.harbourmaster/config.json`. It holds the
// machine credential, so the file is mode 600 and the directory mode 700, both
// owned by the daemon's user. That is what keeps `hm-agent` out of it.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MACHINE_CREDENTIAL } from "@repo/protocol/token-prefixes";
import { z } from "zod";

const CONFIG_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

export const configSchema = z.strictObject({
  // The resolved `claude` the daemon runs, or null when there is none on the
  // PATH. With `singleUser` false it is also the path the sudoers rule names.
  claudeBinary: z.string().nullable(),
  credential: z.string().refine(MACHINE_CREDENTIAL.matches),
  machineId: z.string().min(1),
  // Origin of the Harbourmaster Worker, no trailing slash.
  server: z.url(),
  singleUser: z.boolean(),
});
export type DaemonConfig = z.infer<typeof configSchema>;

export const defaultConfigPath = (home: string = homedir()): string =>
  join(home, ".harbourmaster", "config.json");

/**
 * Reads and validates the config. A thrown message names the path and the
 * failing fields, never the file's contents: the credential lives in there.
 */
export const readConfig = (
  path: string = defaultConfigPath()
): DaemonConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `No config at ${path}. Run \`harbourmaster enroll <code> --server <url>\` first.`,
      { cause: error }
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // biome-ignore lint/style/useErrorCause: a JSON syntax error quotes the offending text, and this file holds the credential.
    throw new Error(`The config at ${path} is not valid JSON.`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config at ${path} is not usable: ${fields}`);
  }
  return result.data;
};

/**
 * Writes the config through a temporary file in the same directory, so a crash
 * cannot leave a truncated file and the credential is never readable at a wider
 * mode. The explicit chmod covers a directory or file that already existed.
 */
export const writeConfig = (
  config: DaemonConfig,
  path: string = defaultConfigPath()
): void => {
  const directory = dirname(path);
  mkdirSync(directory, { mode: CONFIG_DIR_MODE, recursive: true });
  chmodSync(directory, CONFIG_DIR_MODE);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: CONFIG_MODE,
  });
  chmodSync(temporary, CONFIG_MODE);
  renameSync(temporary, path);
};
