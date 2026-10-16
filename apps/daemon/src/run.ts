// The `run` command: keeps the relay connection open until a signal or the
// relay ends it for good. The Bun process stays alive because the relay client
// holds its socket and timers, and this module awaits the shutdown promise.

import type { RelayFrame } from "@repo/protocol/machine";
import {
  createDaemonClient,
  realTimers,
  type Timers,
  type WebSocketFactory,
} from "./client.ts";
import type { DaemonConfig } from "./config.ts";
import { EXIT_OK } from "./exit-codes.ts";
import type { Logger } from "./log.ts";

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
  log: Logger;
  random?: () => number;
  signals?: SignalSubscribe;
  timers?: Timers;
  wsFactory: WebSocketFactory;
}

const describeFrame = (frame: RelayFrame): string | null => {
  if (frame.type === "offer") {
    return `offer for run ${frame.runId}`;
  }
  if (frame.type === "cancel") {
    return `cancel for run ${frame.runId}`;
  }
  return null;
};

/**
 * Runs until a signal or a relay stop. Resolves with the exit code: EXIT_OK
 * on a signal, the relay's code (3 for a rejected credential) otherwise.
 */
export const runCommand = async (options: RunOptions): Promise<number> => {
  const { config, daemonVersion, log, random, wsFactory } = options;
  const signals = options.signals ?? processSignals;
  const timers = options.timers ?? realTimers;

  let finish: (exitCode: number) => void = () => undefined;
  const shutdown = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const onFrame = (frame: RelayFrame) => {
    const line = describeFrame(frame);
    if (line !== null) {
      log.info(line);
    }
  };

  const client = createDaemonClient({
    credential: config.credential,
    daemonVersion,
    log,
    onFrame,
    onStop: finish,
    random,
    server: config.server,
    timers,
    wsFactory,
  });

  const unsubscribe = signals(() => {
    log.info("stopping");
    finish(EXIT_OK);
  });

  log.info(`running as machine ${config.machineId} against ${config.server}`);
  client.start();

  const exitCode = await shutdown;
  client.stop();
  unsubscribe();
  return exitCode;
};
