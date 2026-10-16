// The environment for the Claude Code child process. The daemon's own
// environment is filtered down to what the child needs to run. The child signs
// in with the machine's Claude subscription, so no API key or chat token passes.

/**
 * Names passed through as they are: where executables and temp files live,
 * the locale, the terminal, and the user identity a shell expects.
 */
export const ALLOW_EXACT: ReadonlySet<string> = new Set([
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

/**
 * Name prefixes passed through: the XDG base directories that hold Claude
 * Code's sign-in and config. `CLAUDE_*` is not here as a prefix, because a
 * daemon started from inside a Claude Code session inherits that session's
 * bridge and child-session variables, and the child must not.
 */
export const ALLOW_PREFIXES: readonly string[] = ["XDG_"];

/**
 * Denied whatever the allow list says. These two mark a Claude Code session,
 * and the child would take itself for a nested one if it inherited them.
 */
export const DENY_EXACT: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);

/**
 * Secret-shaped names, denied whatever the allow list says. Only
 * `CLAUDE_CONFIG_DIR` passes of the `CLAUDE_` names, and the pattern is the
 * backstop for any name added to the allow list later.
 */
export const DENY_PATTERN = /TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|PASSWD/i;

const isPassed = (name: string): boolean =>
  (ALLOW_EXACT.has(name) ||
    ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix))) &&
  !DENY_EXACT.has(name) &&
  !DENY_PATTERN.test(name);

/**
 * Build the child's environment from `source`. The caller passes the
 * environment in; this function reads nothing itself. Undefined values are
 * dropped, and `source` is not changed.
 */
export const buildAgentEnv = (
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && isPassed(name)) {
      env[name] = value;
    }
  }
  return env;
};
