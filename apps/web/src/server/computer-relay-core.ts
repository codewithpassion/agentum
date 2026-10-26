// The logic of one machine's computer socket, kept free of `cloudflare:workers`
// so bun can test it with fake sockets, storage and timers, like
// `relay-core.ts` does for the daemon. `relay.ts` hosts both inside the one
// `MachineRelay` object and routes each socket here by its `computer` tag.
//
// Ported from agentum `modules/computer/relay.ts` (the self-hosted host's
// Durable Object): the v1 hello, request and reply correlation by id, the
// stale and orphan handling, and the desktop lease. Left out: hosts in D1,
// the viewer hub (V6.10) and fly lifecycle. Added: up to `MAX_IN_FLIGHT_EXEC`
// commands in flight with `MAX_QUEUE_DEPTH` waiting behind them, where agentum
// ran one at a time.
import {
  CLOSE_BAD_HELLO,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  type ClientReply,
  classifyClientFrame,
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  type DesktopClipboardSetRequest,
  type DesktopInputRequest,
  type DesktopScreenshotRequest,
  desktopInputTimeoutMs,
  type ExecRequest,
  type FileGetRequest,
  type FilePutRequest,
  type HelloMessage,
  HelloMessageSchema,
  isDesktopOp,
  MAX_IN_FLIGHT_EXEC,
  MAX_QUEUE_DEPTH,
  offlineMessage,
  RELAY_GRACE_MS,
  STALE_AFTER_MS,
  STALENESS_POLL_MS,
} from "@repo/protocol/computer";
import type {
  MachinePrincipal,
  MachinesService,
} from "@repo/services/machines";
import type {
  ComputerControl,
  ComputerFailureReason,
  ComputerOutcome,
  ComputerPrincipal,
  ComputerStatus,
  TakeHumanLeaseOutcome,
} from "@repo/services/machines/types";
import { z } from "zod";
import {
  IDENTITY_KEY,
  type RelaySocket,
  type RelayStorage,
} from "./relay-core.ts";

/** The socket tag the Durable Object accepts a computer's socket under. */
export const COMPUTER_TAG = "computer";

/** How often a connected computer is checked and its `last_seen_at` written. */
export const PRESENCE_ALARM_MS = 60_000;
/** The longest a command may run, whatever the caller asked for. */
export const EXEC_MAX_TIMEOUT_MS = 600_000;
/** Used when a request names no timeout of its own. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** A machine that has been away for a long time has nothing left worth cancelling. */
export const MAX_ORPHANS = 64;

const GENERATION_KEY = "computer:generation";
const HELLO_KEY = "computer:hello";
const LAST_SEEN_KEY = "computer:lastSeenAt";
const LEASE_KEY = "computer:lease";
const ORPHANS_KEY = "computer:orphans";

/** A crash backstop: a hold that goes idle for this long is let go. */
export const AGENT_LEASE_IDLE_MS = 10 * 60_000;
export const HUMAN_LEASE_IDLE_MS = 5 * 60_000;
/** Renewals live in memory and reach storage at most this often. */
export const LEASE_PERSIST_INTERVAL_MS = 30_000;
/** After this many failed clears in a row, commands and file transfers run again. */
export const FAILED_CLEARS_BEFORE_COMMANDS = 3;
/** Answers to a clear that mean there is nothing left to clear. */
const NOTHING_TO_CLEAR_CODES: ReadonlySet<string> = new Set([
  "read_only",
  "desktop_unavailable",
]);
/** Clears both selections, so nothing a person put there outlives their control. */
const CLEAR_CLIPBOARD = {
  op: "desktop_clipboard_set",
  selections: ["clipboard", "primary"],
  text: "",
  timeout_ms: DESKTOP_CLIPBOARD_TIMEOUT_MS,
} as const;

const HUMAN_IN_CONTROL_MESSAGE =
  "A person has taken control of this computer. Desktop actions and commands are paused until they hand it back.";
const CLEARING_MESSAGE =
  "The desktop is being cleared after a person used it. It is available again once the computer confirms.";
const OTHER_PERSON_MESSAGE = "Another person has control of this desktop.";
const LEASE_REQUIRED_MESSAGE = "Take control of the desktop first.";
const AGENT_BUSY_MESSAGE =
  "Another agent is using the desktop of this computer.";
const NOT_A_DESKTOP_OP_MESSAGE = "A person may only send desktop operations";
const QUEUE_FULL_MESSAGE =
  "Too many commands are waiting for this computer. Try again shortly.";
const CLEAR_FAILED_MESSAGE =
  "The last person's clipboard could not be cleared yet. Try again once the computer is online.";
const TIMED_OUT =
  "The computer did not answer in time. It may be busy or its connection may have dropped.";
const CONNECTION_LOST =
  "The connection to the computer closed before it answered. Check that the computer is still running and try again.";
const STALE_MESSAGE =
  "The computer stopped sending heartbeats while this request was in flight.";
const REPLACED_MESSAGE =
  "The computer reconnected while this request was in flight.";
const REVOKED_MESSAGE = "The computer has been revoked.";
const DUPLICATE_ID_MESSAGE = "A request with this id is already in flight.";

const PrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ agentId: z.string().optional(), kind: z.literal("agent") }),
  z.object({ kind: z.literal("human"), userId: z.string() }),
]);
const StoredLeaseSchema = z.discriminatedUnion("kind", [
  z.object({
    holder: PrincipalSchema,
    kind: z.literal("held"),
    lastOpAt: z.number(),
  }),
  z.object({
    failedClears: z.number().int().nonnegative(),
    kind: z.literal("clearing"),
  }),
]);
/**
 * Who controls the desktop; absent means nobody. `clearing` is the gap after a
 * person's control ends and before the machine confirms both clipboard
 * selections are empty.
 */
type StoredLease = z.infer<typeof StoredLeaseSchema>;
type HeldLease = Extract<StoredLease, { kind: "held" }>;

/** What `request()` decided about one op before anything was sent. */
type Decision =
  | { kind: "send" }
  | { kind: "send_and_renew" }
  | { kind: "refuse"; reason: ComputerFailureReason; message: string };

const SEND: Decision = { kind: "send" };
const SEND_AND_RENEW: Decision = { kind: "send_and_renew" };

const refusal = (
  reason: ComputerFailureReason,
  message: string
): ComputerOutcome => ({ code: null, message, ok: false, reason });

/** Undefined on either side matches: an agent that never named itself is the computer's agent. */
const sameAgent = (
  held: string | undefined,
  asked: string | undefined
): boolean => held === undefined || asked === undefined || held === asked;

/** Whether `principal` is the controller: the same agent, or the same person. */
const holdsControl = (
  holder: ComputerPrincipal,
  principal: ComputerPrincipal
): boolean => {
  if (holder.kind === "agent") {
    return (
      principal.kind === "agent" && sameAgent(holder.agentId, principal.agentId)
    );
  }
  return principal.kind === "human" && principal.userId === holder.userId;
};

const leaseExpiresAt = (lease: HeldLease): number =>
  lease.lastOpAt +
  (lease.holder.kind === "agent" ? AGENT_LEASE_IDLE_MS : HUMAN_LEASE_IDLE_MS);

const controlOf = (lease: HeldLease): ComputerControl => ({
  expiresAt: leaseExpiresAt(lease),
  holder: lease.holder,
});

/** An agent's op against the lease: `cancel` always goes, a person's hold stops everything else. */
const decideForAgent = ({
  lease,
  op,
  principal,
}: {
  lease: StoredLease | undefined;
  op: string;
  principal: ComputerPrincipal;
}): Decision => {
  if (op === "cancel") {
    return SEND;
  }
  if (lease?.kind === "clearing") {
    const commandsResume =
      !isDesktopOp(op) && lease.failedClears >= FAILED_CLEARS_BEFORE_COMMANDS;
    return commandsResume
      ? SEND
      : { kind: "refuse", message: CLEARING_MESSAGE, reason: "desktop_busy" };
  }
  if (lease?.holder.kind === "human") {
    return {
      kind: "refuse",
      message: HUMAN_IN_CONTROL_MESSAGE,
      reason: "human_in_control",
    };
  }
  if (!isDesktopOp(op)) {
    return SEND;
  }
  // The agent a lease names is the only one the desktop is free for.
  if (lease === undefined || holdsControl(lease.holder, principal)) {
    return SEND_AND_RENEW;
  }
  return {
    kind: "refuse",
    message: AGENT_BUSY_MESSAGE,
    reason: "desktop_busy",
  };
};

/** A person's op against the lease: watching is free, and only the holder may input. */
const decideForPerson = ({
  lease,
  op,
  principal,
}: {
  lease: StoredLease | undefined;
  op: string;
  principal: ComputerPrincipal;
}): Decision => {
  if (!isDesktopOp(op)) {
    return {
      kind: "refuse",
      message: NOT_A_DESKTOP_OP_MESSAGE,
      reason: "forbidden",
    };
  }
  if (lease?.kind === "clearing") {
    return {
      kind: "refuse",
      message: CLEARING_MESSAGE,
      reason: "desktop_busy",
    };
  }
  if (
    lease?.holder.kind === "human" &&
    !holdsControl(lease.holder, principal)
  ) {
    return {
      kind: "refuse",
      message: OTHER_PERSON_MESSAGE,
      reason: "human_in_control",
    };
  }
  // Watching needs no lease and renews none: only input keeps a person in control.
  if (op === "desktop_screenshot") {
    return SEND;
  }
  if (lease !== undefined && holdsControl(lease.holder, principal)) {
    return SEND_AND_RENEW;
  }
  return {
    kind: "refuse",
    message: LEASE_REQUIRED_MESSAGE,
    reason: "forbidden",
  };
};

/** What the socket keeps about itself. It survives hibernation. */
interface SocketAttachment {
  readonly connectedAt: number;
  readonly generation: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSocketAttachment = (value: unknown): value is SocketAttachment =>
  isRecord(value) &&
  typeof value.generation === "number" &&
  typeof value.connectedAt === "number";

/** How long to wait for one reply: what the message asked for, capped, plus the grace. */
const deadlineFor = (message: Record<string, unknown>): number => {
  const asked = message.timeout_ms;
  const requested =
    typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, EXEC_MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  return requested + RELAY_GRACE_MS;
};

const toOutcome = (reply: ClientReply): ComputerOutcome => {
  if (!reply.ok) {
    return {
      code: reply.error.code,
      message: reply.error.message,
      ok: false,
      reason: "client_error",
    };
  }
  return { ok: true, resultJson: reply.result_json };
};

/** Starts timers the core can cancel, so tests run it under fake time. */
export interface Scheduler {
  /** Calls `run` once after `ms`. Returns the function that cancels it. */
  after: (ms: number, run: () => void) => () => void;
  /** Calls `run` every `ms`. Returns the function that stops it. */
  every: (ms: number, run: () => void) => () => void;
}

export const systemScheduler: Scheduler = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
};

export interface ComputerRelayDeps<S extends RelaySocket = RelaySocket> {
  /** Keeps the object alive for work nobody awaits, as `ctx.waitUntil` does. */
  background: (work: Promise<unknown>) => void;
  /** When the platform last answered a heartbeat for the socket, in epoch milliseconds. */
  heartbeatAt: (socket: S) => number | null;
  machines: Pick<MachinesService, "markComputerOffline" | "markComputerOnline">;
  newId?: () => string;
  /** Epoch milliseconds. */
  now: () => number;
  scheduler?: Scheduler;
  /** The computer-tagged sockets only. */
  sockets: () => S[];
  storage: RelayStorage;
}

interface Pending<S extends RelaySocket> {
  readonly cancelPoll: () => void;
  readonly cancelTimer: () => void;
  readonly settle: (outcome: ComputerOutcome) => void;
  readonly socket: S;
}

const logFailure = (what: string, error: unknown) => {
  console.error(`MachineRelay computer: ${what} failed`, error);
};

export const createComputerRelayCore = <S extends RelaySocket = RelaySocket>({
  background,
  heartbeatAt,
  machines,
  newId = () => crypto.randomUUID(),
  now,
  scheduler = systemScheduler,
  sockets,
  storage,
}: ComputerRelayDeps<S>) => {
  let generation = 0;
  let hello: HelloMessage | null = null;
  let loaded: Promise<void> | null = null;
  /** Set once storage has been read; after that, a lease decision needs no await. */
  let hydrated = false;
  /** In memory on purpose: renewals reach storage at most every LEASE_PERSIST_INTERVAL_MS. */
  let lease: StoredLease | undefined;
  let leasePersistedAt = 0;
  let clearInFlight: Promise<boolean> | undefined;
  let inFlightExec = 0;
  let orphanWrites: Promise<unknown> = Promise.resolve();
  const execWaiters: (() => void)[] = [];
  const pending = new Map<string, Pending<S>>();

  const load = (): Promise<void> => {
    loaded ??= (async () => {
      generation = (await storage.get<number>(GENERATION_KEY)) ?? 0;
      const storedHello = HelloMessageSchema.safeParse(
        await storage.get(HELLO_KEY)
      );
      hello = storedHello.success ? storedHello.data : null;
      const storedLease = StoredLeaseSchema.safeParse(
        await storage.get(LEASE_KEY)
      );
      lease = storedLease.success ? storedLease.data : undefined;
      leasePersistedAt = lease?.kind === "held" ? lease.lastOpAt : 0;
      hydrated = true;
    })();
    return loaded;
  };

  const identity = async (): Promise<MachinePrincipal | null> => {
    const stored = await storage.get<{
      machineId: string;
      workspaceId: string;
    }>(IDENTITY_KEY);
    return stored ? { kind: "machine", ...stored } : null;
  };

  const closeQuietly = (socket: RelaySocket, code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      // Already closing. The close handler still runs for it.
    }
  };

  /** The socket of the current generation, ignoring one that is closing or superseded. */
  const currentSocket = (): S | undefined =>
    sockets().find((socket) => {
      const attachment = socket.deserializeAttachment();
      return (
        isSocketAttachment(attachment) && attachment.generation === generation
      );
    });

  /** The platform records every auto-answered heartbeat, so liveness survives hibernation. */
  const lastHeartbeatAt = (socket: S): number | null => {
    const stamp = heartbeatAt(socket);
    if (stamp !== null) {
      return stamp;
    }
    const attachment = socket.deserializeAttachment();
    return isSocketAttachment(attachment) ? attachment.connectedAt : null;
  };

  /** Wakes for the next presence check, or for a held lease's expiry, whichever comes first. */
  const armAlarm = async (): Promise<void> => {
    const wakes: number[] = [];
    if (currentSocket() !== undefined) {
      wakes.push(now() + PRESENCE_ALARM_MS);
    }
    if (lease?.kind === "held") {
      wakes.push(leaseExpiresAt(lease));
    }
    if (wakes.length > 0) {
      await storage.setAlarm(Math.min(...wakes));
    }
  };

  const noteSeen = async (at: number): Promise<void> => {
    await storage.put(LAST_SEEN_KEY, at);
  };

  // Settling requests.

  const finish = (id: string, outcome: ComputerOutcome) => {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    entry.cancelTimer();
    entry.cancelPoll();
    entry.settle(outcome);
  };

  /** Ids whose caller is gone, kept in storage because the machine may return after a hibernation. */
  const rememberOrphan = (id: string): Promise<unknown> => {
    // One write at a time, so two failures in the same tick keep both ids.
    orphanWrites = orphanWrites.then(async () => {
      const stored = (await storage.get<string[]>(ORPHANS_KEY)) ?? [];
      await storage.put(ORPHANS_KEY, [...stored, id].slice(-MAX_ORPHANS));
    });
    return orphanWrites;
  };

  /**
   * Fails one request whose command may still be running on the machine, and
   * remembers its id so a cancel follows when the machine next connects.
   */
  const fail = (id: string, reason: ComputerFailureReason, message: string) => {
    if (!pending.has(id)) {
      return;
    }
    background(rememberOrphan(id));
    finish(id, refusal(reason, message));
  };

  /** Settles every waiting request, or only those owed by one socket. */
  const failAll = (
    reason: ComputerFailureReason,
    message: string,
    socket?: S
  ) => {
    const ids = [...pending]
      .filter(([, entry]) => socket === undefined || entry.socket === socket)
      .map(([id]) => id);
    for (const id of ids) {
      fail(id, reason, message);
    }
  };

  /** Waiting requests re-check the socket's heartbeat, so a dead peer is noticed before TCP. */
  const checkStale = (id: string) => {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    const last = lastHeartbeatAt(entry.socket);
    if (last === null || now() - last <= STALE_AFTER_MS) {
      return;
    }
    closeQuietly(entry.socket, CLOSE_STALE, "heartbeat went stale");
    fail(id, "stale", STALE_MESSAGE);
  };

  /** Cancels the commands whose caller was lost, on the socket that just arrived. */
  const cancelOrphans = async (socket: S): Promise<void> => {
    await orphanWrites;
    const orphaned = (await storage.get<string[]>(ORPHANS_KEY)) ?? [];
    if (orphaned.length === 0) {
      return;
    }
    await storage.delete(ORPHANS_KEY);
    for (const targetId of orphaned) {
      try {
        socket.send(
          JSON.stringify({ id: newId(), op: "cancel", target_id: targetId })
        );
      } catch {
        // The new socket went too; the bounded loss is the rest of the list.
        return;
      }
    }
  };

  // The lease.

  const setLease = (next: StoredLease | undefined) => {
    lease = next;
    leasePersistedAt = next?.kind === "held" ? next.lastOpAt : 0;
    background(
      next === undefined
        ? storage.delete(LEASE_KEY)
        : storage.put(LEASE_KEY, next)
    );
    if (next?.kind === "held") {
      background(armAlarm());
    }
  };

  const desktopUnavailableMessage = (): string => {
    const reason = hello?.capabilities.desktop_unavailable_reason;
    return `The computer has no desktop running${reason ? `: ${reason}` : ""}`;
  };

  const offlineReason = async (): Promise<string> => {
    const lastSeenAt = (await storage.get<number>(LAST_SEEN_KEY)) ?? null;
    return offlineMessage({
      computerName: hello?.hostname ?? "this machine",
      lastSeenAt,
      now: now(),
    });
  };

  const dispatch = async (
    message: Record<string, unknown>
  ): Promise<ComputerOutcome> => {
    await load();
    const socket = currentSocket();
    if (!socket) {
      return refusal("offline", await offlineReason());
    }
    const id = typeof message.id === "string" ? message.id : newId();
    if (pending.has(id)) {
      return refusal("duplicate_id", DUPLICATE_ID_MESSAGE);
    }
    const outcome = new Promise<ComputerOutcome>((resolve) => {
      // Registered before the send, so an answer that arrives at once has somewhere to land.
      pending.set(id, {
        cancelPoll: scheduler.every(STALENESS_POLL_MS, () => checkStale(id)),
        cancelTimer: scheduler.after(deadlineFor(message), () =>
          fail(id, "timeout", TIMED_OUT)
        ),
        settle: resolve,
        socket,
      });
    });
    try {
      socket.send(JSON.stringify({ ...message, id }));
    } catch {
      fail(id, "interrupted", CONNECTION_LOST);
    }
    return await outcome;
  };

  const countFailedClear = () => {
    if (lease?.kind === "clearing") {
      setLease({ failedClears: lease.failedClears + 1, kind: "clearing" });
    }
  };

  /**
   * Clears both selections, then ends the clearing state. A clear that fails
   * leaves the desktop clearing on purpose; the next op, alarm or reconnect
   * sends it again. Only failures from a machine that answered count towards
   * letting commands through: an offline machine says nothing about its
   * clipboard.
   */
  const sendClear = async (): Promise<boolean> => {
    // With no desktop running there is no X server, so no selection is left for anyone to read.
    if (hello?.capabilities.desktop === true) {
      const outcome = await dispatch({ ...CLEAR_CLIPBOARD });
      if (!outcome.ok) {
        const nothingToClear =
          outcome.code !== null && NOTHING_TO_CLEAR_CODES.has(outcome.code);
        if (!nothingToClear) {
          if (outcome.code !== null || outcome.reason === "timeout") {
            countFailedClear();
          }
          return false;
        }
      }
    }
    if (lease?.kind === "clearing") {
      setLease(undefined);
    }
    return true;
  };

  /** One clear at a time: everyone waiting on the desktop waits on the same one. */
  const clearClipboard = (): Promise<boolean> => {
    if (clearInFlight === undefined) {
      const clearing = sendClear().finally(() => {
        clearInFlight = undefined;
      });
      clearInFlight = clearing;
      background(clearing);
    }
    return clearInFlight;
  };

  /** A person's control ends here; nobody drives or reads the desktop until the clear is confirmed. */
  const startClearing = (): StoredLease => {
    const clearing: StoredLease = { failedClears: 0, kind: "clearing" };
    setLease(clearing);
    clearClipboard();
    return clearing;
  };

  /**
   * The controller as of `at`. An idle agent simply lets go; a person who went
   * quiet leaves the desktop clearing. Every call while clearing retries the clear.
   */
  const currentLease = (at: number): StoredLease | undefined => {
    if (lease?.kind === "clearing") {
      clearClipboard();
      return lease;
    }
    if (lease === undefined || at < leaseExpiresAt(lease)) {
      return lease;
    }
    if (lease.holder.kind === "agent") {
      setLease(undefined);
      return;
    }
    return startClearing();
  };

  /**
   * Takes or renews the hold for `principal`. The holder recorded stays the one
   * already holding it, so a renewal by an unnamed agent keeps the agent's id.
   * A new holder is written at once; a renewal only when the stored time is stale.
   */
  const renewLease = (principal: ComputerPrincipal, at: number): HeldLease => {
    const previous = lease;
    if (previous?.kind === "held" && holdsControl(previous.holder, principal)) {
      const next: HeldLease = {
        holder: previous.holder,
        kind: "held",
        lastOpAt: at,
      };
      if (at - leasePersistedAt >= LEASE_PERSIST_INTERVAL_MS) {
        setLease(next);
      } else {
        lease = next;
      }
      return next;
    }
    const next: HeldLease = { holder: principal, kind: "held", lastOpAt: at };
    setLease(next);
    return next;
  };

  /**
   * The per-op check against the one desktop controller. Under a person's
   * control, and while their clipboard is being cleared, every agent op but
   * `cancel` is refused: `exec` runs with DISPLAY set, so it could read the
   * screen or clipboard behind the tools. Once the machine has failed enough
   * clears in a row, commands and file transfers run again.
   */
  const decide = (
    op: string,
    principal: ComputerPrincipal,
    at: number
  ): Decision => {
    const current = currentLease(at);
    return principal.kind === "agent"
      ? decideForAgent({ lease: current, op, principal })
      : decideForPerson({ lease: current, op, principal });
  };

  // Commands: up to MAX_IN_FLIGHT_EXEC at once, MAX_QUEUE_DEPTH waiting.

  const releaseExecSlot = () => {
    const next = execWaiters.shift();
    if (next) {
      // The slot passes to the next waiter, so the count stays.
      next();
      return;
    }
    inFlightExec -= 1;
  };

  /**
   * Waits for a slot, then re-checks the lease: a person may have taken the
   * desktop while the command was queued. The command's own timeout starts
   * when it is sent, not when it was asked for.
   */
  const runExec = async (
    message: Record<string, unknown>,
    principal: ComputerPrincipal
  ): Promise<ComputerOutcome> => {
    if (inFlightExec >= MAX_IN_FLIGHT_EXEC) {
      if (execWaiters.length >= MAX_QUEUE_DEPTH) {
        return refusal("queue_full", QUEUE_FULL_MESSAGE);
      }
      await new Promise<void>((resolve) => {
        execWaiters.push(resolve);
      });
    } else {
      inFlightExec += 1;
    }
    try {
      const late = decide("exec", principal, now());
      if (late.kind === "refuse") {
        return refusal(late.reason, late.message);
      }
      return await dispatch(message);
    } finally {
      releaseExecSlot();
    }
  };

  /**
   * One protocol message to the computer, resolved with its outcome. Never
   * throws: a machine with no socket answers `offline` here and now, rather than
   * making the caller wait for a timeout. `principal` is who the op is for.
   */
  const request = async (
    message: Record<string, unknown>,
    principal: ComputerPrincipal
  ): Promise<ComputerOutcome> => {
    if (!hydrated) {
      await load();
    }
    // Decided before the first await, so two callers can never both take a free lease.
    const op = typeof message.op === "string" ? message.op : "";
    if (isDesktopOp(op) && hello?.capabilities.desktop !== true) {
      return refusal("desktop_unavailable", desktopUnavailableMessage());
    }
    const at = now();
    const decision = decide(op, principal, at);
    if (decision.kind === "refuse") {
      return refusal(decision.reason, decision.message);
    }
    if (decision.kind === "send_and_renew") {
      // Checked before renewing, so an offline machine answers offline instead of taking a lease.
      if (currentSocket() === undefined) {
        return refusal("offline", await offlineReason());
      }
      renewLease(principal, at);
    }
    if (op === "exec") {
      return await runExec(message, principal);
    }
    return await dispatch(message);
  };

  // Connections.

  /**
   * A new connection from the machine named by the Worker's headers. The old
   * socket is told it was replaced (4409), and what was in flight on it fails,
   * so a restarted client that connects before its old socket's close arrives
   * does not stop itself. Call this before accepting the new socket, then
   * `accepted` with the socket and this generation.
   */
  const connect = async (who: {
    machineId: string;
    workspaceId: string;
  }): Promise<{ generation: number }> => {
    await load();
    await storage.put(IDENTITY_KEY, who);
    generation += 1;
    await storage.put(GENERATION_KEY, generation);
    for (const old of sockets()) {
      closeQuietly(
        old,
        CLOSE_REPLACED,
        "Replaced by a newer connection for this computer."
      );
    }
    failAll("replaced", REPLACED_MESSAGE);
    return { generation };
  };

  /** The new socket is in the object's set: stamp it, and cancel what its predecessor left running. */
  const accepted = async (socket: S, forGeneration: number): Promise<void> => {
    const attachment: SocketAttachment = {
      connectedAt: now(),
      generation: forGeneration,
    };
    socket.serializeAttachment(attachment);
    await armAlarm();
    background(cancelOrphans(socket));
  };

  const onHello = async (
    socket: S,
    who: MachinePrincipal,
    next: HelloMessage
  ): Promise<void> => {
    hello = next;
    const at = now();
    await storage.put(HELLO_KEY, next);
    await noteSeen(at);
    try {
      if ((await machines.markComputerOnline(who, next)) === "revoked") {
        closeQuietly(socket, CLOSE_REVOKED, REVOKED_MESSAGE);
        return;
      }
    } catch (error) {
      // The socket is the live thing and the row a projection of it. The alarm writes it again.
      logFailure("marking the computer online", error);
    }
    // A clear that failed while the machine was away is sent again as soon as it is back.
    currentLease(at);
  };

  const onMessage = async (
    socket: S,
    raw: ArrayBuffer | string
  ): Promise<void> => {
    if (typeof raw !== "string") {
      return;
    }
    const frame = classifyClientFrame(raw);
    if (frame.kind === "unreadable_hello") {
      closeQuietly(
        socket,
        CLOSE_BAD_HELLO,
        "this server cannot read that hello"
      );
      return;
    }
    if (frame.kind === "hello") {
      await load();
      const attachment = socket.deserializeAttachment();
      // Only the connection that owns the current generation may say who it is.
      if (
        !isSocketAttachment(attachment) ||
        attachment.generation !== generation
      ) {
        return;
      }
      const who = await identity();
      if (who) {
        await onHello(socket, who, frame.hello);
      }
      return;
    }
    if (frame.kind !== "reply") {
      // A computer that speaks nonsense is not worth dropping the socket over; the
      // request waiting on it times out on its own.
      return;
    }
    const entry = pending.get(frame.reply.id);
    // An answer from a socket that no longer owns the request is nobody's to take.
    if (entry === undefined || entry.socket !== socket) {
      return;
    }
    finish(frame.reply.id, toOutcome(frame.reply));
  };

  const markOffline = async (who: MachinePrincipal) => {
    try {
      await machines.markComputerOffline(who);
    } catch (error) {
      logFailure("marking the computer offline", error);
    }
  };

  /** The socket closed. The computer is offline only if that was the last one. */
  const closed = async (socket: S): Promise<void> => {
    await load();
    failAll("interrupted", CONNECTION_LOST, socket);
    // A replacement connects before the old socket's close is delivered, so
    // the question is "was that the last one?", not "did one close?".
    if (sockets().some((other) => other !== socket)) {
      return;
    }
    const who = await identity();
    if (!who) {
      return;
    }
    // It was alive until this moment, so "last seen" is now.
    await noteSeen(now());
    await markOffline(who);
  };

  /**
   * Presence while connected: `last_seen_at` moves once a minute, not per
   * heartbeat, and a socket the platform has heard no heartbeat from is closed
   * and marked offline. Also expires an idle desktop hold, with or without the
   * computer.
   */
  const alarm = async (): Promise<void> => {
    await load();
    currentLease(now());
    const socket = currentSocket();
    const who = await identity();
    if (!(socket && who)) {
      await armAlarm();
      return;
    }
    const at = now();
    const last = lastHeartbeatAt(socket);
    if (last !== null && at - last > STALE_AFTER_MS) {
      closeQuietly(socket, CLOSE_STALE, "heartbeat went stale");
      failAll("stale", STALE_MESSAGE, socket);
      await markOffline(who);
      await armAlarm();
      return;
    }
    await noteSeen(at);
    if (hello) {
      try {
        if ((await machines.markComputerOnline(who, hello)) === "revoked") {
          closeQuietly(socket, CLOSE_REVOKED, REVOKED_MESSAGE);
        }
      } catch (error) {
        logFailure("marking the computer online", error);
      }
    }
    await armAlarm();
  };

  /**
   * The credential behind the open sockets is gone: close them with 4401, which
   * the client treats as terminal, and fail what is in flight.
   */
  const revoke = (): void => {
    for (const socket of sockets()) {
      closeQuietly(socket, CLOSE_REVOKED, REVOKED_MESSAGE);
    }
    failAll("revoked", REVOKED_MESSAGE);
  };

  // What a caller can ask of the computer.

  const AGENT: ComputerPrincipal = { kind: "agent" };

  /** The connection state, what the client said in its hello, and who holds the desktop. */
  const status = async (): Promise<ComputerStatus> => {
    await load();
    const current = currentLease(now());
    return {
      capabilities: hello?.capabilities ?? null,
      connected: currentSocket() !== undefined,
      control: current?.kind === "held" ? controlOf(current) : null,
      hostname: hello?.hostname ?? null,
      inFlightExec,
      lastSeenAt: (await storage.get<number>(LAST_SEEN_KEY)) ?? null,
      queued: execWaiters.length,
      version: hello?.version ?? null,
      workdir: hello?.workdir ?? null,
    };
  };

  /**
   * A person takes the desktop, preempting any agent at once. Taking it from
   * another person, or while the last person's clipboard is still being cleared,
   * waits for that clear first, so one person never reads what another copied.
   */
  const takeHumanLease = async (
    userId: string
  ): Promise<TakeHumanLeaseOutcome> => {
    await load();
    if (hello?.capabilities.desktop !== true) {
      return {
        message: desktopUnavailableMessage(),
        ok: false,
        reason: "desktop_unavailable",
      };
    }
    // Re-checked after every clear: someone else may have taken control while it was in flight.
    for (;;) {
      const current = currentLease(now());
      const anotherPerson =
        current?.kind === "held" &&
        current.holder.kind === "human" &&
        current.holder.userId !== userId;
      if (current?.kind !== "clearing" && !anotherPerson) {
        break;
      }
      if (anotherPerson) {
        startClearing();
      }
      // biome-ignore lint/performance/noAwaitInLoops: each clear must settle before the next check
      if (!(await clearClipboard())) {
        return {
          message: CLEAR_FAILED_MESSAGE,
          ok: false,
          reason: "desktop_busy",
        };
      }
    }
    const held = renewLease({ kind: "human", userId }, now());
    return { control: controlOf(held), ok: true };
  };

  /**
   * A person hands the desktop back. Nobody gets it until both clipboard
   * selections are cleared; a clear that fails leaves it clearing.
   */
  const releaseHumanLease = async (
    userId: string
  ): Promise<{ clipboardCleared: boolean; released: boolean }> => {
    await load();
    const current = currentLease(now());
    if (
      current?.kind !== "held" ||
      current.holder.kind !== "human" ||
      current.holder.userId !== userId
    ) {
      return { clipboardCleared: false, released: false };
    }
    startClearing();
    return { clipboardCleared: await clearClipboard(), released: true };
  };

  return {
    accepted,
    alarm,
    clipboardGet: (principal: ComputerPrincipal = AGENT) =>
      request(
        {
          op: "desktop_clipboard_get",
          timeout_ms: DESKTOP_CLIPBOARD_TIMEOUT_MS,
        },
        principal
      ),
    clipboardSet: (
      principal: ComputerPrincipal,
      input: Omit<DesktopClipboardSetRequest, "op">
    ) =>
      request(
        {
          ...input,
          op: "desktop_clipboard_set",
          timeout_ms: DESKTOP_CLIPBOARD_TIMEOUT_MS,
        },
        principal
      ),
    closed,
    connect,
    desktopInput: (
      principal: ComputerPrincipal,
      input: Omit<DesktopInputRequest, "op">
    ) =>
      request(
        {
          ...input,
          op: "desktop_input",
          timeout_ms: desktopInputTimeoutMs(input.actions),
        },
        principal
      ),
    desktopScreenshot: (
      principal: ComputerPrincipal,
      input: Omit<DesktopScreenshotRequest, "op">
    ) =>
      request(
        {
          ...input,
          op: "desktop_screenshot",
          timeout_ms: DESKTOP_SCREENSHOT_TIMEOUT_MS,
        },
        principal
      ),
    exec: (principal: ComputerPrincipal, input: Omit<ExecRequest, "op">) =>
      request({ ...input, op: "exec" }, principal),
    fileGet: (
      principal: ComputerPrincipal,
      input: Omit<FileGetRequest, "op">
    ) => request({ ...input, op: "file_get" }, principal),
    filePut: (
      principal: ComputerPrincipal,
      input: Omit<FilePutRequest, "op">
    ) => request({ ...input, op: "file_put" }, principal),
    message: onMessage,
    releaseHumanLease,
    request,
    revoke,
    status,
    takeHumanLease,
  };
};

export type ComputerRelayCore = ReturnType<typeof createComputerRelayCore>;
