// The `agentum` command line. This file reads argv and picks the command;
// each command lives in its own module and returns its exit code.

import { parseArgs } from "node:util";
import type { WebSocketFactory } from "./client.ts";
import type { CommandRunner } from "./command.ts";
import { spawnCommand } from "./command.ts";
import { type DaemonConfig, readConfig } from "./config.ts";
import { enrollCommand } from "./enroll.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";
import {
  type InstallServiceOptions,
  installServiceCommand,
} from "./install-service.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { runCommand } from "./run.ts";
import { statusCommand } from "./status.ts";
import { DAEMON_VERSION } from "./version.ts";
import { bunWebSocketFactory } from "./websocket.ts";

export interface MainDeps {
  configPath: string | undefined;
  fetch: typeof fetch;
  log: Logger;
  run: CommandRunner;
  wsFactory: WebSocketFactory;
}

const DEFAULT_DEPS: MainDeps = {
  configPath: undefined,
  fetch,
  log: consoleLogger,
  run: spawnCommand,
  wsFactory: bunWebSocketFactory,
};

const USAGE = `Usage: agentum <command> [options]

Commands:
  enroll <code> --server <url> [--claude <path>]
                                     Enroll this machine with an Agentum server.
  run                                Run the daemon in the foreground.
  status                             Show the daemon's config and service state.
  install-service [--claude <path>] [--refresh]
                                     Install the systemd user service and the hm-agent user.
                                     --refresh only points the service at this binary and
                                     restarts it, for an update.

Run install-service before enroll, so that enroll reports single_user false on a
machine where hm-agent is set up.

Options:
  --claude <path>  The claude binary, when it is not on the PATH. Give the same path to
                   install-service and enroll.
  -h, --help       Show this usage.
  -v, --version    Print the daemon version.`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseCli = (argv: string[]) =>
  parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      claude: { type: "string" },
      help: { short: "h", type: "boolean" },
      refresh: { type: "boolean" },
      server: { type: "string" },
      version: { short: "v", type: "boolean" },
    },
    strict: true,
  });

const usageError = (log: Logger, message: string): number => {
  log.error(message);
  log.error(USAGE);
  return EXIT_FAILURE;
};

/** Returns the process exit code. */
export const main = async (
  argv: string[],
  deps: Partial<MainDeps> = {}
): Promise<number> => {
  const {
    configPath,
    fetch: doFetch,
    log,
    run,
    wsFactory,
  } = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    log.error(messageOf(error));
    return EXIT_FAILURE;
  }
  const { positionals, values } = parsed;

  if (values.version) {
    log.info(DAEMON_VERSION);
    return EXIT_OK;
  }
  if (values.help) {
    log.info(USAGE);
    return EXIT_OK;
  }

  const [command, code] = positionals;
  switch (command) {
    case undefined:
      log.error(USAGE);
      return EXIT_FAILURE;

    case "enroll": {
      const { server } = values;
      if (!(code && server)) {
        return usageError(
          log,
          "enroll needs an enrolment code and --server <url>"
        );
      }
      return await enrollCommand({
        claudeBinary: values.claude,
        code,
        configPath,
        fetch: doFetch,
        log,
        run,
        server,
      });
    }

    case "run": {
      let config: DaemonConfig;
      try {
        config = readConfig(configPath);
      } catch (error) {
        log.error(messageOf(error));
        return EXIT_FAILURE;
      }
      return await runCommand({
        config,
        daemonVersion: DAEMON_VERSION,
        fetch: doFetch,
        log,
        run,
        wsFactory,
      });
    }

    case "status":
      return await statusCommand({ configPath, log, run });

    case "install-service": {
      const options: InstallServiceOptions = {
        claudeBinary: values.claude,
        log,
        refresh: values.refresh === true,
        run,
        ...(configPath === undefined ? {} : { configPath }),
      };
      return await installServiceCommand(options);
    }

    default:
      return usageError(log, `unknown command: ${command}`);
  }
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
