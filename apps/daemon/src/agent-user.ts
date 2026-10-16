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
 * The absolute, symlink-free path of the `claude` the daemon's user has on its
 * PATH, or `undefined` when there is none. `override` skips the PATH lookup.
 */
export const resolveClaudeBinary = async (
  run: CommandRunner,
  override?: string
): Promise<string | undefined> => {
  let found = override;
  if (found === undefined) {
    const which = await run(["which", "claude"]);
    found = which.exitCode === 0 ? which.stdout.trim() : "";
  }
  if (found === "") {
    return;
  }
  const real = await run(["realpath", found]);
  const resolved = real.exitCode === 0 ? real.stdout.trim() : "";
  return resolved === "" ? found : resolved;
};

/**
 * Whether sudo lets the daemon's user run `claudeBinary` as `hm-agent` without
 * a password. `sudo -l <command>` answers without running the command.
 */
export const canRunAsAgent = async (
  run: CommandRunner,
  claudeBinary: string
): Promise<boolean> => {
  const listed = await run([
    "sudo",
    "-n",
    "-u",
    AGENT_USER,
    "-l",
    claudeBinary,
  ]);
  return listed.exitCode === 0;
};
