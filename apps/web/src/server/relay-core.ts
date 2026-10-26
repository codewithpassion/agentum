// The logic of one machine's relay, kept free of `cloudflare:workers` so bun
// can test it with fake sockets and storage. `relay.ts` wraps it in the
// Durable Object. The relay is transport only: runs live in D1, and the one
// thing the relay owns is the socket and the proof that it is still alive.
import {
  CLOSE_CODES,
  daemonFrameSchema,
  FEATURE_LIBRARY_LIVE,
  LEASE_SECONDS,
  type RelayFrame,
} from "@repo/protocol/machine";
import type {
  MachinePrincipal,
  MachinesService,
} from "@repo/services/machines";

/** The headers the Worker stamps on the upgrade it hands the relay. */
export const RELAY_HEADER_MACHINE_ID = "x-hm-machine-id";
export const RELAY_HEADER_WORKSPACE_ID = "x-hm-workspace-id";
/** Which role's socket this is: `daemon` or `computer`. Only the Worker sets it. */
export const RELAY_HEADER_ROLE = "x-hm-role";
export const RELAY_ROLES = ["daemon", "computer"] as const;
export type RelayRole = (typeof RELAY_ROLES)[number];

/** A machine that sends nothing for this long is offline. Same span as a run lease. */
export const PRESENCE_TIMEOUT_MS = LEASE_SECONDS * 1000;

/**
 * Pings arrive every 20 seconds, and `last_seen_at` only has to be good enough
 * to read on a page, so a ping writes it at most this often. The `status`
 * column is what says whether a machine is there.
 */
export const LAST_SEEN_WRITE_MS = 120_000;

/** The machine named by the Worker's headers. Both roles of one machine share it. */
export const IDENTITY_KEY = "identity";
const LAST_PING_KEY = "lastPingAt";
const LAST_WRITE_KEY = "lastSeenWrittenAt";

export interface RelaySocket {
  close: (code?: number, reason?: string) => void;
  deserializeAttachment: () => unknown;
  send: (data: string) => void;
  serializeAttachment: (value: unknown) => void;
}

/** What the socket keeps about its daemon. It survives hibernation. */
interface SocketAttachment {
  features: string[];
}

const isSocketAttachment = (value: unknown): value is SocketAttachment =>
  typeof value === "object" &&
  value !== null &&
  "features" in value &&
  Array.isArray(value.features) &&
  value.features.every((feature) => typeof feature === "string");

/** The part of `DurableObjectStorage` the relay uses. */
export interface RelayStorage {
  delete: (key: string) => Promise<unknown>;
  deleteAlarm: () => Promise<void>;
  get: <T>(key: string) => Promise<T | undefined>;
  getAlarm: () => Promise<number | null>;
  put: <T>(key: string, value: T) => Promise<void>;
  setAlarm: (at: number) => Promise<void>;
}

export interface RelayCoreDeps {
  machines: Pick<
    MachinesService,
    "markOffline" | "markOnline" | "pendingOffers"
  >;
  /** Epoch milliseconds. */
  now: () => number;
  sockets: () => RelaySocket[];
  storage: RelayStorage;
}

const logFailure = (what: string, error: unknown) => {
  console.error(`MachineRelay: ${what} failed`, error);
};

export const createRelayCore = ({
  machines,
  now,
  sockets,
  storage,
}: RelayCoreDeps) => {
  const identity = async (): Promise<MachinePrincipal | null> => {
    const stored = await storage.get<{
      machineId: string;
      workspaceId: string;
    }>(IDENTITY_KEY);
    return stored ? { kind: "machine", ...stored } : null;
  };

  const takesLibraryFrames = (socket: RelaySocket): boolean => {
    const attachment = socket.deserializeAttachment();
    return (
      isSocketAttachment(attachment) &&
      attachment.features.includes(FEATURE_LIBRARY_LIVE)
    );
  };

  const send = (socket: RelaySocket, frame: RelayFrame) => {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // Closed mid-send. The close handler marks the machine offline.
    }
  };

  const closeQuietly = (socket: RelaySocket, code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      // Already closing. There is nothing left to tell it.
    }
  };

  const reject = (socket: RelaySocket) => {
    closeQuietly(
      socket,
      CLOSE_CODES.credentialRejected,
      "Credential rejected."
    );
  };

  /**
   * Records that the machine was heard from, keeps an alarm armed one presence
   * window out, and answers whether `last_seen_at` is due a write. The alarm is
   * armed only when none is pending: pushing it out on every ping would stop it
   * from ever firing while pings keep coming, and its handler re-arms itself
   * from the stored last ping.
   */
  const heard = async (at: number, force: boolean): Promise<boolean> => {
    await storage.put(LAST_PING_KEY, at);
    if ((await storage.getAlarm()) === null) {
      await storage.setAlarm(at + PRESENCE_TIMEOUT_MS);
    }
    const lastWrite = (await storage.get<number>(LAST_WRITE_KEY)) ?? 0;
    if (!force && at - lastWrite < LAST_SEEN_WRITE_MS) {
      return false;
    }
    await storage.put(LAST_WRITE_KEY, at);
    return true;
  };

  /**
   * A D1 failure must never cost the machine its socket: the socket is the
   * live thing, and the row is a projection of it. A failed write is logged,
   * and the next ping writes again.
   */
  const markOnline = async (
    who: MachinePrincipal,
    capabilities?: Record<string, unknown>
  ): Promise<"failed" | "ok" | "revoked"> => {
    try {
      return await machines.markOnline(who, { capabilities });
    } catch (error) {
      logFailure("marking the machine online", error);
      await storage.delete(LAST_WRITE_KEY);
      return "failed";
    }
  };

  const markOffline = async (
    who: MachinePrincipal,
    reason: "disconnected" | "silent"
  ) => {
    try {
      await machines.markOffline(who, reason);
    } catch (error) {
      logFailure("marking the machine offline", error);
    }
    // The next ping must write `online` again, whatever the throttle says.
    await storage.delete(LAST_WRITE_KEY);
  };

  /** Every queued or offered run of the machine's agents, oldest first. */
  const offerPending = async (socket: RelaySocket, who: MachinePrincipal) => {
    try {
      for (const { agentId, runId } of await machines.pendingOffers(who)) {
        send(socket, { agentId, runId, type: "offer" });
      }
    } catch (error) {
      logFailure("offering queued runs", error);
    }
  };

  /**
   * A new connection from the machine named by the Worker's headers. The old
   * socket is told it was replaced (1012), not that its credential is gone
   * (4401), so a restarted daemon that connects before its old socket's close
   * arrives does not stop itself. Call this before accepting the new socket.
   */
  const connect = async (who: {
    machineId: string;
    workspaceId: string;
  }): Promise<void> => {
    await storage.put(IDENTITY_KEY, who);
    for (const old of sockets()) {
      closeQuietly(
        old,
        CLOSE_CODES.replaced,
        "Replaced by a newer connection."
      );
    }
    const at = now();
    await storage.put(LAST_PING_KEY, at);
    await storage.setAlarm(at + PRESENCE_TIMEOUT_MS);
  };

  const parse = (raw: string) => {
    try {
      const frame = daemonFrameSchema.safeParse(JSON.parse(raw));
      return frame.success ? frame.data : null;
    } catch {
      return null;
    }
  };

  const message = async (
    socket: RelaySocket,
    raw: ArrayBuffer | string
  ): Promise<void> => {
    if (typeof raw !== "string") {
      return;
    }
    const who = await identity();
    const frame = parse(raw);
    // A daemon that speaks nonsense is not worth dropping the socket over: its
    // next ping decides whether it is still there.
    if (!(who && frame)) {
      return;
    }
    const at = now();
    if (frame.type === "hello") {
      socket.serializeAttachment({ features: frame.features ?? [] });
      await heard(at, true);
      const status = await markOnline(who, {
        ...frame.capabilities,
        daemonVersion: frame.daemonVersion,
      });
      if (status === "revoked") {
        reject(socket);
        return;
      }
      send(socket, {
        machineId: who.machineId,
        serverTime: new Date(at).toISOString(),
        type: "hello_ack",
      });
      await offerPending(socket, who);
      return;
    }
    if ((await heard(at, false)) && (await markOnline(who)) === "revoked") {
      reject(socket);
    }
  };

  /**
   * A kill -9 sends no close frame, so silence is the only signal. The alarm
   * fires one presence window after the last ping and re-arms itself while the
   * machine is still talking.
   */
  const alarm = async (): Promise<void> => {
    const who = await identity();
    if (!who) {
      return;
    }
    const lastPing = (await storage.get<number>(LAST_PING_KEY)) ?? 0;
    const deadline = lastPing + PRESENCE_TIMEOUT_MS;
    if (now() < deadline) {
      await storage.setAlarm(deadline);
      return;
    }
    await markOffline(who, "silent");
  };

  /** The socket closed. The machine is offline only if that was the last one. */
  const closed = async (socket: RelaySocket): Promise<void> => {
    // A replacement connects before the old socket's close is delivered, so
    // the question is "was that the last one?", not "did one close?".
    if (sockets().some((other) => other !== socket)) {
      return;
    }
    const who = await identity();
    if (!who) {
      return;
    }
    await markOffline(who, "disconnected");
    await storage.deleteAlarm();
  };

  /** Offers one run to the open sockets. Idempotent: the claim is a conditional write. */
  const offer = (run: { agentId: string; runId: string }): void => {
    for (const socket of sockets()) {
      send(socket, { ...run, type: "offer" });
    }
  };

  /** Tells the open sockets whose daemon named `library-live` that these paths changed. */
  const announce = (paths: string[]): void => {
    for (const socket of sockets()) {
      if (takesLibraryFrames(socket)) {
        send(socket, { paths, type: "library_changed" });
      }
    }
  };

  const cancel = (runId: string): void => {
    for (const socket of sockets()) {
      send(socket, { runId, type: "cancel" });
    }
  };

  /** The credential behind the open sockets is gone. */
  const revoke = (): void => {
    for (const socket of sockets()) {
      reject(socket);
    }
  };

  return {
    alarm,
    announce,
    cancel,
    closed,
    connect,
    message,
    offer,
    revoke,
  };
};

export type RelayCore = ReturnType<typeof createRelayCore>;
