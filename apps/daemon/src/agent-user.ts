// The `hm-agent` Unix user and the sudoers rule that lets the daemon's user run
// Claude Code as it. `install-service` creates both; `enroll` probes them to
// decide `single_user`.

import type { CommandRunner } from "./command.ts";

export const AGENT_USER = "hm-agent";
export const SUDOERS_DIR = "/etc/sudoers.d";

// Characters that end a command in a sudoers rule unless a backslash precedes
// them: space, comma, colon, equals sign and backslash.
const SUDOERS_SPECIAL = /[ ,:=\\]/g;
const FILE_NAME_UNSAFE = /[^A-Za-z0-9_-]/g;

/**
 * The line that lets `user` run exactly `claudeBinary` as `hm-agent`, with
 * any arguments and no password.
 */
export const sudoersLine = (user: string, claudeBinary: string): string =>
  `${user} ALL=(${AGENT_USER}) NOPASSWD: ${claudeBinary.replace(SUDOERS_SPECIAL, "\\$&")}`;

/** The whole drop-in file for `user`. */
export const sudoersFile = (user: string, claudeBinary: string): string =>
  `# Managed by harbourmaster install-service.\n${sudoersLine(user, claudeBinary)}\n`;

/**
 * Where the drop-in for `user` lives. sudo skips files in sudoers.d whose name
 * contains a dot, so anything outside letters, digits, `_` and `-` becomes `_`.
 */
export const sudoersPath = (user: string): string =>
  `${SUDOERS_DIR}/harbourmaster-${user.replace(FILE_NAME_UNSAFE, "_")}`;

/**
 * The absolute path of the `claude` the daemon's user has on its PATH, or
 * `undefined` when there is none. `override` skips the PATH lookup. Symlinks
 * stay as they are: `claude` updates itself by moving a symlink to a new
 * versioned file, and sudo matches the path as typed, so a resolved path in
 * the sudoers rule would go stale at the first update.
 */
export const resolveClaudeBinary = async (
  run: CommandRunner,
  override?: string
): Promise<string | undefined> => {
  if (override !== undefined) {
    return override === "" ? undefined : override;
  }
  const which = await run(["which", "claude"]);
  const found = which.exitCode === 0 ? which.stdout.trim() : "";
  return found.startsWith("/") ? found : undefined;
};

/**
 * Whether the daemon's user can really run `claudeBinary` as `hm-agent`
 * without a password. It runs the binary: `sudo -l` would only read the policy,
 * and would say yes through an unrelated rule or a cached password, or for a
 * binary that `hm-agent` cannot reach because it lives in a private home
 * directory. `-k` ignores cached credentials and `-n` refuses to prompt.
 */
export const canRunAsAgent = async (
  run: CommandRunner,
  claudeBinary: string
): Promise<boolean> => {
  const ran = await run([
    "sudo",
    "-k",
    "-n",
    "-u",
    AGENT_USER,
    claudeBinary,
    "--version",
  ]);
  return ran.exitCode === 0;
};
