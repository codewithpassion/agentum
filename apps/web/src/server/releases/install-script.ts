// An install script is a POSIX `sh` file with this placeholder where the
// server's origin goes. The route fills it in per request.

export const ORIGIN_PLACEHOLDER = "@@HM_ORIGIN@@";

/** The script with this deployment's origin in it. `origin` has no trailing slash. */
export const renderInstallScript = (template: string, origin: string): string =>
  template.replaceAll(ORIGIN_PLACEHOLDER, origin);

/**
 * What the retired `/install.sh` (the TypeScript daemon) and
 * `/install-computer.sh` (the Go computer client) answer. It is a script that
 * prints the new command and fails, so `curl -fsSL <origin>/install.sh | sh`
 * shows the message in the terminal. A 4xx status would hide it, because
 * `curl -f` drops the body.
 */
export const retiredInstallScript = (origin: string): string =>
  [
    "#!/bin/sh",
    "cat >&2 <<'EOF'",
    "This installer is retired. The TypeScript daemon and the Go computer client",
    "are gone, and one Agentum client now does both jobs. Install it with:",
    "",
    `  curl -fsSL ${origin}/install-agentum.sh | sh`,
    "",
    "To enrol it in the same step, create a code on the Machines page and run:",
    "",
    `  curl -fsSL ${origin}/install-agentum.sh | AGENTUM_ENROLL_CODE=<code> sh`,
    "EOF",
    "exit 1",
    "",
  ].join("\n");
