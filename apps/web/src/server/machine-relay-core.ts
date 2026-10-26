// One machine's relay, the daemon's socket, the computer's and the people
// watching its desktop. A machine has one Durable Object (V6.1's decision,
// written out at the top of `relay.ts`), so this is where a socket is told
// apart by the tag it was accepted under and handed to the core for its role.
// Kept free of
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
import {
  createViewerHub,
  VIEWER_TAG,
  type ViewerAttachment,
} from "./viewer-hub.ts";

/** The socket tag the daemon is accepted under. The computer's is `COMPUTER_TAG`. */
export const DAEMON_TAG = "daemon";

export interface MachineRelayCoreDeps<S extends RelaySocket> {
  background: ComputerRelayDeps<S>["background"];
  heartbeatAt: ComputerRelayDeps<S>["heartbeatAt"];
  machines: RelayCoreDeps["machines"] & ComputerRelayDeps<S>["machines"];
  newId?: ComputerRelayDeps<S>["newId"];
  now: () => number;
  scheduler?: ComputerRelayDeps<S>["scheduler"];
  /** Pauses the viewer pump between frames. Tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
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
  sleep,
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
    // The hub is built next and only used once a status changes, after this returns.
    statusChanged: () => viewers.statusChanged(),
    storage: alarms.view(COMPUTER_TAG),
  });
  // The people watching the desktop. The hub asks the computer core for frames
  // and input as the person, so the desktop lease decides what they may do.
  const viewers = createViewerHub<S>(
    {
      desktopInput: computer.desktopInput,
      desktopScreenshot: computer.desktopScreenshot,
      status: computer.status,
      viewerSockets: () => tagged(VIEWER_TAG),
    },
    { clock: now, sleep }
  );

  /** The handler for a socket by its tag, or null for a tag this object does not serve. */
  const coreOf = (socket: S) => {
    const tags = tagsOf(socket);
    if (tags.includes(COMPUTER_TAG)) {
      return computer;
    }
    if (tags.includes(VIEWER_TAG)) {
      return viewerCore;
    }
    return tags.includes(DAEMON_TAG) ? daemon : null;
  };

  /** A viewer socket only sends acks and input, and nothing is owed when it closes. */
  const viewerCore = {
    closed: (socket: S): Promise<void> => {
      viewers.close(socket);
      return Promise.resolve();
    },
    message: (socket: S, raw: ArrayBuffer | string): Promise<void> => {
      viewers.message(socket, raw);
      return Promise.resolve();
    },
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
    // A viewer changes nothing about the machine: it must not bump the
    // computer's generation, replace its socket or rewrite the daemon's identity.
    if (role === VIEWER_TAG) {
      return { generation: 0 };
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

  /** A person's socket, accepted under `viewer`: remember who they are and start sending frames. */
  const acceptViewer = (socket: S, userId: string): void => {
    const attachment: ViewerAttachment = { kind: "viewer", userId };
    socket.serializeAttachment(attachment);
    viewers.open(socket);
  };

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
    // Viewers that outlived this object's memory have no pump until something reminds it of them.
    viewers.adoptAll(tagged(VIEWER_TAG));
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
    acceptViewer,
    alarm,
    closed,
    computer,
    connect,
    daemon,
    message,
    revoke,
    viewers,
  };
};

export type MachineRelayCore<S extends RelaySocket = RelaySocket> = ReturnType<
  typeof createMachineRelayCore<S>
>;
