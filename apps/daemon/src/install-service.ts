// `harbourmaster install-service`: a systemd user unit so the daemon survives a
// reboot, plus the `hm-agent` Unix user that Claude Code runs as. The command
// runs as the daemon's own user and calls `sudo` for the steps that need root.
//
// A user unit only survives logout when the user has lingering enabled, so the
// install checks for it and exits 2 when it is missing.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_USER,
  canRunAsAgent,
  resolveClaudeBinary,
  sudoersFile,
  sudoersPath,
} from "./agent-user.ts";
import type { CommandRunner } from "./command.ts";
import { defaultConfigPath } from "./config.ts";
import { EXIT_FAILURE, EXIT_LINGER_MISSING, EXIT_OK } from "./exit-codes.ts";
import type { Logger } from "./log.ts";

export const SERVICE_NAME = "harbourmaster";

const ROOT_UID = 0;
const AGENT_HOME = `/home/${AGENT_USER}`;
const SUDOERS_FILE_MODE = 0o600;

export const serviceUnitPath = (home: string = homedir()): string =>
  join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`);

/**
 * Quotes a path for `ExecStart=`. Backslash and quote get a backslash in front,
 * and `%` and `$` are doubled so systemd does not read them as specifiers or
 * variables.
 */
const systemdQuote = (value: string): string =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;

export const serviceUnit = (binaryPath: string): string => `[Unit]
Description=Harbourmaster daemon

[Service]
ExecStart=${systemdQuote(binaryPath)} run
Environment="PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
# Exit 3 is a rejected credential. Restarting would storm the relay, which has
# already said no.
RestartPreventExitStatus=3

[Install]
WantedBy=default.target
`;

export interface InstallServiceOptions {
  /** The binary the unit runs. Defaults to the one running this command. */
  readonly binaryPath?: string;
  /** Overrides the PATH lookup for `claude`. */
  readonly claudeBinary?: string;
  readonly configPath?: string;
  readonly getuid?: () => number;
  readonly home?: string;
  readonly log: Logger;
  readonly platform?: NodeJS.Platform;
  readonly run: CommandRunner;
  readonly tempDir?: string;
  readonly username?: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const currentUsername = (): string => {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "";
  }
};

interface AgentUserContext {
  readonly claudeBinary: string | undefined;
  readonly run: CommandRunner;
  readonly tempDir: string;
  readonly username: string;
}

/**
 * Writes the sudoers rule through a temporary file, checks it with visudo, and
 * only then installs it. A broken rule would break sudo for the whole machine.
 * Returns why it was not installed, or undefined when it was.
 */
const installSudoersRule = async (
  context: AgentUserContext,
  claude: string
): Promise<string | undefined> => {
  const { run, tempDir, username } = context;
  const directory = mkdtempSync(join(tempDir, "hm-sudoers-"));
  try {
    const file = join(directory, "sudoers");
    writeFileSync(file, sudoersFile(username, claude), {
      mode: SUDOERS_FILE_MODE,
    });
    const checked = await run(["sudo", "visudo", "-cf", file]);
    if (checked.exitCode !== 0) {
      return `visudo rejected the sudoers rule, so it is not installed: ${checked.stderr.trim()}`;
    }
    const target = sudoersPath(username);
    const installed = await run([
      "sudo",
      "install",
      "-m",
      "0440",
      "-o",
      "root",
      "-g",
      "root",
      file,
      target,
    ]);
    if (installed.exitCode !== 0) {
      return `could not install ${target}: ${installed.stderr.trim()}`;
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

/**
 * Creates the agent user and its sudoers rule. Returns why that failed, or
 * undefined when Claude Code can run as the agent user.
 */
const provisionAgentUser = async (
  context: AgentUserContext,
  log: Logger
): Promise<string | undefined> => {
  const { run, username } = context;
  const exists = await run(["id", "-u", AGENT_USER]);
  if (exists.exitCode === 0) {
    log.info(`${AGENT_USER} already exists`);
  } else {
    const created = await run([
      "sudo",
      "useradd",
      "--system",
      "--create-home",
      "--home-dir",
      AGENT_HOME,
      "--shell",
      "/bin/bash",
      AGENT_USER,
    ]);
    if (created.exitCode !== 0) {
      return `could not create ${AGENT_USER}: ${created.stderr.trim()}`;
    }
    log.info(`created ${AGENT_USER}`);
  }

  const claude = await resolveClaudeBinary(run, context.claudeBinary);
  if (claude === undefined) {
    return "claude is not on the PATH; install Claude Code, then run install-service again";
  }
  const sudoersError = await installSudoersRule(context, claude);
  if (sudoersError !== undefined) {
    return sudoersError;
  }
  if (!(await canRunAsAgent(run, claude))) {
    return `${username} could not run ${claude} as ${AGENT_USER}. The binary must be executable by ${AGENT_USER}, so it cannot sit in a private home directory. Install it system-wide, then run install-service again with --claude <path>`;
  }
  log.info(
    `Claude Code will run as ${AGENT_USER}; enroll will report single_user false`
  );
};

/** Returns the process exit code. */
export const installServiceCommand = async (
  options: InstallServiceOptions
): Promise<number> => {
  const platform = options.platform ?? process.platform;
  const { log, run } = options;
  if (platform === "darwin") {
    log.error("launchd is not supported yet");
    return EXIT_FAILURE;
  }
  if (platform !== "linux") {
    log.error(`no service installer for ${platform} yet`);
    return EXIT_FAILURE;
  }

  const getuid = options.getuid ?? (() => process.getuid?.() ?? -1);
  if (getuid() === ROOT_UID) {
    log.error(
      "run install-service as the user that will run the daemon, not as root: it calls sudo itself for the steps that need root"
    );
    return EXIT_FAILURE;
  }

  const home = options.home ?? homedir();
  const username = options.username ?? currentUsername();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const unitPath = serviceUnitPath(home);
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, serviceUnit(options.binaryPath ?? process.execPath));
  log.info(`wrote ${unitPath}`);

  // The agent user is optional. Any failure here means the machine runs Claude
  // Code as the daemon's own user, and the install carries on.
  let agentError: string | undefined;
  try {
    agentError = await provisionAgentUser(
      {
        claudeBinary: options.claudeBinary,
        run,
        tempDir: options.tempDir ?? tmpdir(),
        username,
      },
      log
    );
  } catch (error) {
    agentError = `agent user setup failed: ${errorMessage(error)}`;
  }
  if (agentError !== undefined) {
    log.error(agentError);
    log.info(
      `single_user: this machine will run Claude Code as ${username}, the daemon's own user`
    );
  }

  const systemctl = async (args: string[]): Promise<boolean> => {
    const command = ["systemctl", "--user", ...args];
    const result = await run(command);
    if (result.exitCode === 0) {
      return true;
    }
    log.error(`${command.join(" ")} failed: ${result.stderr.trim()}`);
    log.error(
      `if the daemon must survive logout, enable lingering: loginctl enable-linger ${username}`
    );
    return false;
  };

  if (!(await systemctl(["daemon-reload"]))) {
    return EXIT_FAILURE;
  }
  if (!(await systemctl(["enable", SERVICE_NAME]))) {
    return EXIT_FAILURE;
  }
  if (existsSync(configPath)) {
    if (!(await systemctl(["restart", SERVICE_NAME]))) {
      return EXIT_FAILURE;
    }
    log.info(`${SERVICE_NAME} enabled and restarted`);
  } else {
    // Restarting without a config would crash-loop under Restart=on-failure.
    log.info(
      `this machine is not enrolled yet. Next: harbourmaster enroll <code> --server <url>, then systemctl --user restart ${SERVICE_NAME}`
    );
  }
  log.info(`follow it with: journalctl --user -u ${SERVICE_NAME} -f`);

  const linger = await run(["loginctl", "show-user", username, "-p", "Linger"]);
  if (linger.exitCode === 0 && linger.stdout.includes("Linger=yes")) {
    return EXIT_OK;
  }
  log.error(`lingering is off for ${username}`);
  log.error(
    `the daemon stops at logout until lingering is on. Enable it with: loginctl enable-linger ${username}`
  );
  return EXIT_LINGER_MISSING;
};
