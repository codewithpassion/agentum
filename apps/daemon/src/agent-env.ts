// The environment for the Claude Code child process. The daemon's own
// environment is filtered down to what the child needs to run. The child signs
// in with the machine's Claude subscription, so no API key or chat token passes.

/**
 * Names passed through as they are: where executables and temp files live,
 * the locale, the terminal, and the user identity a shell expects.
 */
export const ALLOW_EXACT: ReadonlySet<string> = new Set([
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
 * Name prefixes passed through: Claude Code's own settings and the XDG base
 * directories that hold its sign-in and config.
 */
export const ALLOW_PREFIXES: readonly string[] = ["CLAUDE_", "XDG_"];

/**
 * Denied whatever the allow list says. These two mark a Claude Code session,
 * and the child would take itself for a nested one if it inherited them.
 */
export const DENY_EXACT: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);

/**
 * Secret-shaped names, denied whatever the allow list says. It applies under
 * `CLAUDE_` too, so `CLAUDE_CODE_OAUTH_TOKEN` never reaches the child.
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
