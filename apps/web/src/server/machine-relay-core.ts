// One machine's relay, the daemon's socket and the computer's together. A
// machine has one Durable Object (V6.1's decision, written out at the top of
// `relay.ts`), so this is where a socket is told apart by the tag it was
// accepted under and handed to the core for its role. Kept free of
// `cloudflare:workers` so bun can test both roles on one object with fake
// sockets, like `relay-core.ts` does for one.

import {
  COMPUTER_TAG,
  type ComputerRelayDeps,
  createComputerRelayCore,
} from "./computer-relay-core.ts";
import { createAlarmMux } from "./relay-alarms.ts";
import {
  createRelayCore,
  type RelayCoreDeps,
  type RelayRole,
  type RelaySocket,
} from "./relay-core.ts";

/** The socket tag the daemon is accepted under. The computer's is `COMPUTER_TAG`. */
export const DAEMON_TAG = "daemon";

export interface MachineRelayCoreDeps<S extends RelaySocket> {
  background: ComputerRelayDeps<S>["background"];
  heartbeatAt: ComputerRelayDeps<S>["heartbeatAt"];
  machines: RelayCoreDeps["machines"] & ComputerRelayDeps<S>["machines"];
  newId?: ComputerRelayDeps<S>["newId"];
  now: () => number;
  scheduler?: ComputerRelayDeps<S>["scheduler"];
  /** Every socket the object holds, whatever its tag. */
  sockets: () => S[];
  storage: RelayCoreDeps["storage"];
  /** The tags a socket was accepted under. */
  tagsOf: (socket: S) => readonly string[];
}

export const createMachineRelayCore = <S extends RelaySocket>({
  background,
  heartbeatAt,
  machines,
  newId,
  now,
  scheduler,
  sockets,
  storage,
  tagsOf,
}: MachineRelayCoreDeps<S>) => {
  // The object has one alarm. Each core arms and clears its own through a view.
  const alarms = createAlarmMux({
    legacy: DAEMON_TAG,
    names: [DAEMON_TAG, COMPUTER_TAG],
    now,
    storage,
  });
  const tagged = (tag: string): S[] =>
    sockets().filter((socket) => tagsOf(socket).includes(tag));

  const daemon = createRelayCore({
    machines,
    now,
    sockets: () => tagged(DAEMON_TAG),
    storage: alarms.view(DAEMON_TAG),
  });
  const computer = createComputerRelayCore<S>({
    background,
    heartbeatAt,
    machines,
    newId,
    now,
    scheduler,
    sockets: () => tagged(COMPUTER_TAG),
    storage: alarms.view(COMPUTER_TAG),
  });

  /** The handler for a socket by its tag, or null for a tag this object does not serve. */
  const coreOf = (socket: S) => {
    const tags = tagsOf(socket);
    if (tags.includes(COMPUTER_TAG)) {
      return computer;
    }
    return tags.includes(DAEMON_TAG) ? daemon : null;
  };

  /**
   * A new connection for `role` from the machine the Worker's headers name.
   * Returns the generation to pass to `accepted` once the socket is accepted.
   */
  const connect = async (
    role: RelayRole,
    who: { machineId: string; workspaceId: string }
  ): Promise<{ generation: number }> => {
    if (role === COMPUTER_TAG) {
      return await computer.connect(who);
    }
    await daemon.connect(who);
    return { generation: 0 };
  };

  const accepted = (
    role: RelayRole,
    socket: S,
    generation: number
  ): Promise<void> =>
    role === COMPUTER_TAG
      ? computer.accepted(socket, generation)
      : Promise.resolve();

  const message = (socket: S, raw: ArrayBuffer | string): Promise<void> => {
    const core = coreOf(socket);
    return core ? core.message(socket, raw) : Promise.resolve();
  };

  const closed = (socket: S): Promise<void> => {
    const core = coreOf(socket);
    return core ? core.closed(socket) : Promise.resolve();
  };

  /**
   * The object's one alarm. Every core whose wake time is due runs, and one
   * that throws does not stop the others: the first failure is raised once all
   * have run, so the runtime retries.
   */
  const alarm = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const name of await alarms.fire()) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: the cores share one storage, so they run one at a time
        await (name === COMPUTER_TAG ? computer.alarm() : daemon.alarm());
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  };

  /** The credential is gone: every socket of the machine closes with 4401, whatever its tag. */
  const revoke = (): void => {
    daemon.revoke();
    computer.revoke();
  };

  return {
    accepted,
    alarm,
    closed,
    computer,
    connect,
    daemon,
    message,
    revoke,
  };
};

export type MachineRelayCore<S extends RelaySocket = RelaySocket> = ReturnType<
  typeof createMachineRelayCore<S>
>;
