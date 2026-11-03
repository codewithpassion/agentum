// `agentum status`: what the daemon is configured to do and whether its
// service runs. It never prints the credential.

import type { CommandRunner } from "./command.ts";
import { type DaemonConfig, defaultConfigPath, readConfig } from "./config.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";
import { SERVICE_NAME } from "./install-service.ts";
import type { Logger } from "./log.ts";

export interface StatusOptions {
  configPath?: string;
  log: Logger;
  run: CommandRunner;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const serviceState = async (run: CommandRunner): Promise<string> => {
  const cat = await run(["systemctl", "--user", "cat", SERVICE_NAME]);
  if (cat.exitCode !== 0) {
    return "not installed";
  }
  // `is-active` exits non-zero for an inactive unit but still prints the state.
  const active = await run(["systemctl", "--user", "is-active", SERVICE_NAME]);
  const state = active.stdout.trim();
  return state === "" ? "unknown" : state;
};

const describe = (config: DaemonConfig): string[] => [
  `machine: ${config.machineId}`,
  `server: ${config.server}`,
  `single_user: ${config.singleUser}`,
  config.claudeBinary === null
    ? "claude: not found"
    : `claude: ${config.claudeBinary}`,
];

export const statusCommand = async ({
  configPath = defaultConfigPath(),
  log,
  run,
}: StatusOptions): Promise<number> => {
  let config: DaemonConfig;
  try {
    config = readConfig(configPath);
  } catch (error) {
    log.error(messageOf(error));
    return EXIT_FAILURE;
  }
  for (const line of describe(config)) {
    log.info(line);
  }
  log.info(`config: ${configPath}`);
  log.info(`service: ${await serviceState(run)}`);
  return EXIT_OK;
};
