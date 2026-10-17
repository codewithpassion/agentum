// The `hm-agent` Unix user and the sudoers rule that lets the daemon's user run
// Claude Code as it. `install-service` creates both; `enroll` probes them to
// decide `single_user`.

import type { CommandRunner } from "./command.ts";

export const AGENT_USER = "hm-agent";
export const AGENT_HOME = `/home/${AGENT_USER}`;
export const AGENT_MKDIR = "/bin/mkdir";
export const AGENT_RM = "/bin/rm";
// The four commands that move a run's files in and out of hm-agent's work
// directory: `dd` writes stdin to a file, `realpath` and `stat` vet a path, and
// `head` reads a file back.
export const AGENT_DD = "/usr/bin/dd";
export const AGENT_HEAD = "/usr/bin/head";
export const AGENT_REALPATH = "/usr/bin/realpath";
export const AGENT_STAT = "/usr/bin/stat";
/** The `sudo` prefix that runs a command as `hm-agent` without a password prompt. */
export const AS_AGENT: readonly string[] = ["sudo", "-n", "-u", AGENT_USER];
const AGENT_COMMANDS = [
  AGENT_MKDIR,
  AGENT_RM,
  AGENT_DD,
  AGENT_HEAD,
  AGENT_REALPATH,
  AGENT_STAT,
];
export const SUDOERS_DIR = "/etc/sudoers.d";

// Characters that end a command in a sudoers rule unless a backslash precedes
// them: space, comma, colon, equals sign and backslash.
const SUDOERS_SPECIAL = /[ ,:=\\]/g;
const FILE_NAME_UNSAFE = /[^A-Za-z0-9_-]/g;

/**
 * The line that lets `user` run `claudeBinary` as `hm-agent`, and `mkdir`, `rm`,
 * `dd`, `head`, `realpath` and `stat` too, with no password. `CWD=*` lets the
 * daemon pass `sudo -D <dir>`, since its own user cannot enter the agent's
 * home. The helpers add no privilege: claude under bypassPermissions already
 * runs arbitrary commands as `hm-agent`. They let the daemon create and reset
 * directories that `hm-agent` owns, write a run's input files there and read
 * its attachments back, and every file they touch stays `hm-agent`'s. They
 * run as `hm-agent`, so the daemon's own config, which `hm-agent` cannot read,
 * stays out of reach.
 *
 * `SETENV` lets claude keep the agent's secrets through `sudo --preserve-env`
 * (agent-process.ts). The helpers get `NOSETENV`, so they keep their
 * environment reset as before.
 */
export const sudoersLine = (user: string, claudeBinary: string): string =>
  `${user} ALL=(${AGENT_USER}) CWD=* NOPASSWD: SETENV: ${claudeBinary.replace(SUDOERS_SPECIAL, "\\$&")}, NOSETENV: ${AGENT_COMMANDS.join(", ")}`;

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
