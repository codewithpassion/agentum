// The `run` command: keeps the relay connection open until a signal or the
// relay ends it for good, and runs the runs the relay offers. The Bun process
// stays alive because the relay client holds its socket and timers, and this
// module awaits the shutdown promise.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RelayFrame } from "@repo/protocol/machine";
import { createAgentSpawner } from "./agent-process.ts";
import {
  createDaemonClient,
  realTimers,
  type Timers,
  type WebSocketFactory,
} from "./client.ts";
import type { CommandRunner } from "./command.ts";
import { spawnCommand } from "./command.ts";
import type { DaemonConfig } from "./config.ts";
import { executeRun, type QueryFn } from "./executor.ts";
import { EXIT_OK } from "./exit-codes.ts";
import { createFilesApi } from "./files-api.ts";
import type { Logger } from "./log.ts";
import { createMasker } from "./masker.ts";
import { createRunApi } from "./run-api.ts";
import { createRunManager } from "./run-manager.ts";
import { createSkillsApi } from "./skills-api.ts";
import { AGENT_SDK } from "./version.ts";

/** Registers `handler` for SIGINT and SIGTERM and returns the unsubscribe. */
export type SignalSubscribe = (handler: () => void) => () => void;

export const processSignals: SignalSubscribe = (handler) => {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
};

export interface RunOptions {
  config: DaemonConfig;
  daemonVersion: string;
  /** The daemon's own environment, filtered before Claude Code sees it. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log: Logger;
  queryFn?: QueryFn;
  random?: () => number;
  /** Runs the sudo commands that prepare hm-agent's work directories. */
  run?: CommandRunner;
  signals?: SignalSubscribe;
  timers?: Timers;
  wsFactory: WebSocketFactory;
}

/**
 * Runs until a signal or a relay stop. Resolves with the exit code: EXIT_OK
 * on a signal, the relay's code (3 for a rejected credential) otherwise.
 */
export const runCommand = async (options: RunOptions): Promise<number> => {
  const { config, daemonVersion, log, random, wsFactory } = options;
  const signals = options.signals ?? processSignals;
  const timers = options.timers ?? realTimers;
  const doFetch = options.fetch ?? fetch;
  const queryFn = options.queryFn ?? query;
  const runCommandFn = options.run ?? spawnCommand;
  const env = options.env ?? process.env;

  const claimApi = (runId: string) =>
    createRunApi({
      credential: config.credential,
      fetch: doFetch,
      masker: createMasker({ machine_credential: config.credential }),
      runId,
      server: config.server,
    });

  const manager = createRunManager({
    claim: (runId) => claimApi(runId).claim(),
    execute: (claim) =>
      executeRun({
        claim,
        config,
        createApi: (masker) =>
          createRunApi({
            credential: config.credential,
            fetch: doFetch,
            masker,
            runId: claim.run.id,
            server: config.server,
          }),
        createFilesApi: (masker) =>
          createFilesApi({
            fetch: doFetch,
            masker,
            runToken: claim.runToken,
            server: config.server,
          }),
        createSkillsApi: (masker) =>
          createSkillsApi({
            fetch: doFetch,
            masker,
            runId: claim.run.id,
            runToken: claim.runToken,
            server: config.server,
          }),
        env,
        log,
        queryFn,
        run: runCommandFn,
        spawnProcessFor: (onStderr) =>
          createAgentSpawner({ onStderr, singleUser: config.singleUser }),
        timers,
      }),
    log,
  });

  let finish: (exitCode: number) => void = () => undefined;
  const shutdown = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const onFrame = (frame: RelayFrame) => {
    if (frame.type === "offer") {
      log.info(`offer for run ${frame.runId}`);
      manager.offer(frame);
    } else if (frame.type === "cancel") {
      log.info(`cancel for run ${frame.runId}`);
      manager.cancel(frame.runId);
    }
  };

  const client = createDaemonClient({
    agentSdk: AGENT_SDK,
    credential: config.credential,
    daemonVersion,
    log,
    onFrame,
    onReplaced: () => {
      manager.abortAll("the relay connection was replaced (1012)");
    },
    onStop: finish,
    random,
    server: config.server,
    timers,
    wsFactory,
  });

  const unsubscribe = signals(() => {
    log.info("stopping");
    // Runs end as `aborted` before the daemon goes. The server turns a running
    // run into `interrupted` at once, so the lease does not have to expire.
    // The completions are plain HTTP and need no socket.
    manager.stop("the daemon is stopping");
    manager.idle().then(() => finish(EXIT_OK));
  });

  log.info(`running as machine ${config.machineId} against ${config.server}`);
  client.start();

  const exitCode = await shutdown;
  client.stop();
  unsubscribe();
  return exitCode;
};
