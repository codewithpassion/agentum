import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { createDb, type Db } from "#/db/client";
import {
  getHostByIdUnscoped,
  setHostHello,
  setHostStatus,
  touchHostSeen,
} from "./hosts";
import {
  CLOSE_BAD_HELLO,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  CLOSE_STALE,
  type ClientReply,
  classifyClientFrame,
  DESKTOP_CLIPBOARD_TIMEOUT_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type HelloMessage,
  HelloMessageSchema,
  isDesktopOp,
  RELAY_GRACE_MS,
  STALE_AFTER_MS,
  STALENESS_POLL_MS,
} from "./protocol";
import {
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
} from "./remote-client";
import {
  DesktopViewers,
  isViewerAttachment,
  VIEWER_PATH,
  VIEWER_TAG,
  VIEWER_USER_HEADER,
} from "./viewer-hub";

/**
 * One self-hosted host's daemon connection (`idFromName(hostId)`). The container
 * dials out to `/api/computer-hosts/connect`, that route hands the upgraded
 * socket here, and every computer operation for an agent on this host is written
 * to it. Ported from TrueForge's `RemoteComputerDO`. The desktop lease is keyed
 * by agent, not by turn: one host serves one agent.
 *
 * The socket uses the hibernation API. Heartbeats are answered by the platform
 * (`setWebSocketAutoResponse`), so an idle daemon costs nothing. Presence is
 * written on hello, on disconnect, and by a 60 s alarm while connected.
 */

const WEBSOCKET_UPGRADE_REQUIRED = 426;
const BAD_REQUEST = 400;

const HOST_KEY = "hostId";
const GENERATION_KEY = "generation";
const HELLO_KEY = "hello";
const ORPHANS_KEY = "orphaned_request_ids";
/** A machine that has been away for a long time has nothing left worth cancelling. */
const MAX_ORPHANS = 64;
const LAST_SEEN_ALARM_MS = 60_000;

const LEASE_KEY = "desktop_lease";
/** A crash backstop: a hold that goes idle for this long is let go. */
const AGENT_LEASE_IDLE_MS = 10 * 60_000;
const HUMAN_LEASE_IDLE_MS = 5 * 60_000;
/** Renewals live in memory and reach storage at most this often. */
const LEASE_PERSIST_INTERVAL_MS = 30_000;
/** After this many failed clears in a row, commands and file transfers run again. */
const FAILED_CLEARS_BEFORE_COMMANDS = 3;
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
} as const;

const HUMAN_IN_CONTROL_MESSAGE =
  "A person has taken control of this computer. Desktop actions and commands are paused until they hand it back.";
const CLEARING_MESSAGE =
  "The desktop is being cleared after a person used it. It is available again once the computer confirms.";
const OTHER_PERSON_MESSAGE = "Another person has control of this desktop.";
const LEASE_REQUIRED_MESSAGE = "Take control of the desktop first.";
const AGENT_BUSY_MESSAGE =
  "Another agent is using the desktop of this computer.";

/** Added to the operation's own timeout before this side gives up. */
const TIMED_OUT =
  "The computer did not answer in time. It may be busy or its connection may have dropped.";
const CONNECTION_LOST =
  "The connection to the computer closed before it answered. Check that the container is still running and try again.";
const STALE_MESSAGE =
  "The computer stopped sending heartbeats while this request was in flight.";
const REPLACED_MESSAGE =
  "The computer reconnected while this request was in flight.";
const REVOKED_MESSAGE = "The computer has been revoked.";

export type RelayFailureReason =
  | "offline"
  | "timeout"
  | "stale"
  | "replaced"
  | "revoked"
  | "interrupted"
  | "client_error"
  | "duplicate_id"
  | "human_in_control"
  | "forbidden"
  | "desktop_busy"
  | "desktop_unavailable";

/**
 * What a request resolves to. Never thrown across RPC. A failure the daemon
 * reported itself is `client_error`, with its own `code`; anything else is a
 * connection-level reason and has no code.
 */
export interface RelayOutcome {
  readonly code: string | null;
  readonly message: string;
  readonly ok: boolean;
  /** Set on a failure. */
  readonly reason: RelayFailureReason | null;
  /** The reply `result`, as JSON, on success. */
  readonly result_json: string | null;
}

export interface RelayStatus {
  capabilities: HelloMessage["capabilities"] | null;
  connected: boolean;
  /** Who holds the desktop, or null when nobody does (including while it is being cleared). */
  control: ComputerControl | null;
  hostname: string | null;
  version: string | null;
  workdir: string | null;
}

/**
 * Who a request acts for, or who holds the desktop. An agent with no `agentId`
 * matches any agent, because one host serves one agent.
 */
export type ComputerPrincipal =
  | { kind: "agent"; agentId?: string }
  | { kind: "human"; userId: string };

/** Who holds the desktop, and until when. `expiresAt` is epoch milliseconds. */
export interface ComputerControl {
  expiresAt: number;
  holder: ComputerPrincipal;
}

export type TakeHumanLeaseOutcome =
  | { ok: true; control: ComputerControl }
  | {
      ok: false;
      reason: "desktop_busy" | "desktop_unavailable";
      message: string;
    };

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
  | { kind: "refuse"; reason: RelayFailureReason; message: string };

const SEND: Decision = { kind: "send" };
const SEND_AND_RENEW: Decision = { kind: "send_and_renew" };

const refusal = (
  reason: RelayFailureReason,
  message: string
): RelayOutcome => ({
  code: null,
  message,
  ok: false,
  reason,
  result_json: null,
});

/** Undefined on either side matches: an agent that never named itself is the host's agent. */
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
      message: "A person may only send desktop operations",
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

interface SocketAttachment {
  readonly connected_at: number;
  readonly generation: number;
}

interface Pending {
  readonly poll: ReturnType<typeof setInterval>;
  readonly settle: (outcome: RelayOutcome) => void;
  readonly socket: WebSocket;
  readonly timer: ReturnType<typeof setTimeout>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The generation a socket was accepted under, if it carries one. */
function socketGeneration(socket: WebSocket): number | undefined {
  const attachment: unknown = socket.deserializeAttachment();
  return isSocketAttachment(attachment) ? attachment.generation : undefined;
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  return (
    isRecord(value) &&
    typeof value.generation === "number" &&
    typeof value.connected_at === "number"
  );
}

/**
 * The connect route addresses this object by name *and* puts the host id in the
 * path, because a Durable Object cannot be relied on to read back the name it
 * was reached by.
 */
const hostIdFromUrl = (url: string): string | null => {
  const last = new URL(url).pathname.split("/").pop();
  return last ? decodeURIComponent(last) : null;
};

/** How long to wait for one reply: what the message asked for, capped, plus the grace. */
const deadlineFor = (message: Record<string, unknown>): number => {
  const asked = message.timeout_ms;
  const requested =
    typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, REMOTE_EXEC_MAX_TIMEOUT_MS)
      : REMOTE_EXEC_DEFAULT_TIMEOUT_MS;
  return requested + RELAY_GRACE_MS;
};

const toOutcome = (reply: ClientReply): RelayOutcome => {
  if (!reply.ok) {
    return {
      code: reply.error.code,
      message: reply.error.message,
      ok: false,
      reason: "client_error",
      result_json: null,
    };
  }
  return {
    code: null,
    message: "",
    ok: true,
    reason: null,
    result_json: reply.result_json,
  };
};

export class ComputerRelay extends DurableObject<Env> {
  private database: Db | null = null;
  private hostId: string | null = null;
  private generation: number | null = null;
  private hello: HelloMessage | null = null;
  private loaded: Promise<void> | null = null;
  /** Set once `load()` has read storage; after that, a lease decision needs no await. */
  private hydrated = false;

  /** Whether storage has been read, so a lease decision needs no await. */
  private isHydrated(): boolean {
    return this.hydrated;
  }
  private readonly pending = new Map<string, Pending>();
  private readonly viewers = new DesktopViewers({
    request: (message, principal) => this.request(message, principal),
    status: () => this.status(),
    viewerSockets: () => this.viewerSockets(),
  });
  /** The tail of the exec queue: one command in flight per host, as in the DO backend. */
  private execQueue: Promise<unknown> = Promise.resolve();
  /** In memory on purpose: renewals reach storage at most every LEASE_PERSIST_INTERVAL_MS. */
  private lease: StoredLease | undefined;
  private leasePersistedAt = 0;
  private clearInFlight: Promise<boolean> | undefined;

  private db(): Db {
    this.database ??= createDb(this.env.DB);
    return this.database;
  }

  /** Reads what must survive hibernation, once per instance, before anything else runs. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      this.generation =
        (await this.ctx.storage.get<number>(GENERATION_KEY)) ?? 0;
      const stored = HelloMessageSchema.safeParse(
        await this.ctx.storage.get(HELLO_KEY)
      );
      this.hello = stored.success ? stored.data : null;
      this.hostId = (await this.ctx.storage.get<string>(HOST_KEY)) ?? null;
      const storedLease = StoredLeaseSchema.safeParse(
        await this.ctx.storage.get(LEASE_KEY)
      );
      this.lease = storedLease.success ? storedLease.data : undefined;
      this.leasePersistedAt =
        this.lease?.kind === "held" ? this.lease.lastOpAt : 0;
      this.hydrated = true;
    })();
    return this.loaded;
  }

  private async host(): Promise<string | null> {
    await this.load();
    return this.hostId;
  }

  /**
   * The daemon's upgrade, handed over by the connect route. A new connection
   * replaces the old one; the generation in the socket attachment decides which
   * socket is current.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", {
        status: WEBSOCKET_UPGRADE_REQUIRED,
      });
    }
    if (new URL(request.url).pathname === VIEWER_PATH) {
      return this.acceptViewer(request);
    }
    const hostId = hostIdFromUrl(request.url);
    if (!hostId) {
      return new Response("No host id.", { status: BAD_REQUEST });
    }
    await this.load();
    this.hostId = hostId;
    await this.ctx.storage.put(HOST_KEY, hostId);
    const generation = (this.generation ?? 0) + 1;
    this.generation = generation;
    await this.ctx.storage.put(GENERATION_KEY, generation);

    for (const existing of this.daemonSockets()) {
      try {
        existing.close(
          CLOSE_REPLACED,
          "Replaced by a newer connection for this host."
        );
      } catch {
        // Already closing; the generation check keeps it out of dispatch either way.
      }
    }
    this.failAll("replaced", REPLACED_MESSAGE);

    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    const attachment: SocketAttachment = {
      connected_at: Date.now(),
      generation,
    };
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(attachment);
    this.ctx.setWebSocketAutoResponse(
      // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketRequestResponsePair is a Workers runtime global
      new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG)
    );
    await this.ctx.storage.setAlarm(Date.now() + LAST_SEEN_ALARM_MS);
    this.ctx.waitUntil(this.cancelOrphans(pair[1]));
    this.viewers.statusChanged();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A person's viewer socket, handed over by the desktop stream route with the
   * signed-in user in a header only that route sets. Viewer sockets carry no
   * generation, so `currentSocket()` can never mistake one for the daemon.
   */
  private acceptViewer(request: Request): Response {
    const userId = request.headers.get(VIEWER_USER_HEADER);
    if (!userId) {
      return new Response("No viewer.", { status: BAD_REQUEST });
    }
    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [VIEWER_TAG]);
    pair[1].serializeAttachment({ kind: "viewer", userId });
    this.viewers.open(pair[1]);
    // Viewers wake this object every minute, daemon or not, so none is left without a pump.
    this.ctx.waitUntil(this.armAlarm(this.currentSocket() !== undefined));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private viewerSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => isViewerAttachment(socket.deserializeAttachment()));
  }

  /** Every socket the daemon may be on: all but the viewers'. */
  private daemonSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => !isViewerAttachment(socket.deserializeAttachment()));
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: ArrayBuffer | string
  ): Promise<void> {
    if (isViewerAttachment(socket.deserializeAttachment())) {
      this.viewers.message(socket, message);
      return;
    }
    if (typeof message !== "string") {
      return;
    }
    const frame = classifyClientFrame(message);
    if (frame.kind === "unreadable_hello") {
      socket.close(CLOSE_BAD_HELLO, "this server cannot read that hello");
      return;
    }
    if (frame.kind === "hello") {
      await this.load();
      // Only the connection that owns the current generation may say who it is.
      if (socketGeneration(socket) !== this.generation) {
        return;
      }
      await this.onHello(frame.hello);
      return;
    }
    if (frame.kind !== "reply") {
      // A daemon that speaks nonsense is not worth dropping the socket over; the
      // request waiting on it times out on its own.
      return;
    }
    const entry = this.pending.get(frame.reply.id);
    // An answer from a socket that no longer owns the request is nobody's to take.
    if (entry === undefined || entry.socket !== socket) {
      return;
    }
    this.finish(frame.reply.id, toOutcome(frame.reply));
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.dropped(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.dropped(socket);
  }

  /** Viewers leave quietly; only the daemon's loss changes the host's presence. */
  private isViewer(socket: WebSocket): boolean {
    return isViewerAttachment(socket.deserializeAttachment());
  }

  /**
   * Presence while connected: the last-seen column moves once a minute, not per
   * heartbeat. Also expires an idle desktop hold, with or without the daemon.
   */
  override async alarm(): Promise<void> {
    await this.load();
    // Viewers that survived a hibernation have no pump until something reminds this object of them.
    this.viewers.adoptAll(this.viewerSockets());
    this.currentLease(Date.now());
    if (this.currentSocket() === undefined) {
      await this.armAlarm(false);
      return;
    }
    const hostId = await this.host();
    if (hostId) {
      await touchHostSeen(this.db(), hostId);
    }
    await this.armAlarm(true);
  }

  /**
   * One protocol message to the daemon, resolved with its outcome. Never throws:
   * a host with no socket answers `offline` here and now, rather than making the
   * caller wait for a timeout. `principal` is who the op is for; it defaults to
   * an agent, and only desktop ops and agent ops consult the lease with it.
   */
  async request(
    message: Record<string, unknown>,
    principal: ComputerPrincipal = { kind: "agent" }
  ): Promise<RelayOutcome> {
    if (!this.isHydrated()) {
      await this.load();
    }
    // Decided before the first await, so two callers can never both take a free lease.
    const op = typeof message.op === "string" ? message.op : "";
    if (isDesktopOp(op) && this.hello?.capabilities.desktop !== true) {
      return refusal("desktop_unavailable", this.desktopUnavailableMessage());
    }
    const now = Date.now();
    const decision = this.decide(op, principal, now);
    if (decision.kind === "refuse") {
      return refusal(decision.reason, decision.message);
    }
    if (decision.kind === "send_and_renew") {
      // Checked before renewing, so an offline machine answers offline instead of taking a lease.
      if (this.currentSocket() === undefined) {
        return refusal("offline", await this.offlineReason());
      }
      this.renewLease(principal, now);
    }
    if (op === "exec") {
      return await this.enqueueExec(() =>
        this.sendExecIfAllowed(message, principal)
      );
    }
    return await this.dispatch(message);
  }

  /** The connection state, what the daemon said in its hello, and who holds the desktop. */
  async status(): Promise<RelayStatus> {
    await this.load();
    const lease = this.currentLease(Date.now());
    return {
      capabilities: this.hello?.capabilities ?? null,
      connected: this.currentSocket() !== undefined,
      control: lease?.kind === "held" ? controlOf(lease) : null,
      hostname: this.hello?.hostname ?? null,
      version: this.hello?.version ?? null,
      workdir: this.hello?.workdir ?? null,
    };
  }

  /**
   * A person takes the desktop, preempting any agent at once. Taking it from
   * another person, or while the last person's clipboard is still being cleared,
   * waits for that clear first, so one person never reads what another copied.
   */
  async takeHumanLease(userId: string): Promise<TakeHumanLeaseOutcome> {
    await this.load();
    if (this.hello?.capabilities.desktop !== true) {
      return {
        message: this.desktopUnavailableMessage(),
        ok: false,
        reason: "desktop_unavailable",
      };
    }
    // Re-checked after every clear: someone else may have taken control while it was in flight.
    for (;;) {
      const lease = this.currentLease(Date.now());
      const anotherPerson =
        lease?.kind === "held" &&
        lease.holder.kind === "human" &&
        lease.holder.userId !== userId;
      if (lease?.kind !== "clearing" && !anotherPerson) {
        break;
      }
      if (anotherPerson) {
        this.startClearing();
      }
      // biome-ignore lint/performance/noAwaitInLoops: each clear must settle before the next check
      if (!(await this.clearClipboard())) {
        return {
          message:
            "The last person's clipboard could not be cleared yet; try again once the computer is online",
          ok: false,
          reason: "desktop_busy",
        };
      }
    }
    const held = this.renewLease({ kind: "human", userId }, Date.now());
    return { control: controlOf(held), ok: true };
  }

  /**
   * A person hands the desktop back. Nobody gets it until both clipboard
   * selections are cleared; a clear that fails leaves it clearing.
   */
  async releaseHumanLease(
    userId: string
  ): Promise<{ clipboardCleared: boolean; released: boolean }> {
    await this.load();
    const lease = this.currentLease(Date.now());
    if (
      lease?.kind !== "held" ||
      lease.holder.kind !== "human" ||
      lease.holder.userId !== userId
    ) {
      return { clipboardCleared: false, released: false };
    }
    this.startClearing();
    return { clipboardCleared: await this.clearClipboard(), released: true };
  }

  /** Ends an agent's hold at the end of its turn. Other holders are left alone. */
  async releaseAgentLease(agentId: string): Promise<{ released: boolean }> {
    await this.load();
    const lease = this.currentLease(Date.now());
    if (
      lease?.kind !== "held" ||
      lease.holder.kind !== "agent" ||
      !sameAgent(lease.holder.agentId, agentId)
    ) {
      return { released: false };
    }
    this.setLease(undefined);
    return { released: true };
  }

  /**
   * Closes the daemon with 4401, which the client treats as terminal, and fails
   * what is in flight. Called when the host's credential is revoked.
   */
  revoke(): void {
    // Viewers go too: there is no desktop left for them to watch.
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(CLOSE_REVOKED, REVOKED_MESSAGE);
      } catch {
        // Already closing; the close handler still runs for it.
      }
    }
    this.failAll("revoked", REVOKED_MESSAGE);
  }

  private async onHello(hello: HelloMessage): Promise<void> {
    await this.load();
    this.hello = hello;
    await this.ctx.storage.put(HELLO_KEY, hello);
    this.viewers.statusChanged();
    // A clear that failed while the machine was away is sent again as soon as it is back.
    this.currentLease(Date.now());
    const hostId = await this.host();
    if (!hostId) {
      return;
    }
    await setHostHello(this.db(), hostId, hello);
    await setHostStatus(this.db(), hostId, "ready");
    await touchHostSeen(this.db(), hostId);
  }

  /** The socket of the current generation, ignoring one that is closing or superseded. */
  private currentSocket(): WebSocket | undefined {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (
        isSocketAttachment(attachment) &&
        attachment.generation === this.generation
      ) {
        return socket;
      }
    }
  }

  /** The platform records every auto-answered heartbeat, so liveness survives hibernation. */
  private lastHeartbeatAt(socket: WebSocket): number | null {
    const stamp = this.ctx.getWebSocketAutoResponseTimestamp(socket);
    if (stamp !== null) {
      return stamp.getTime();
    }
    const attachment: unknown = socket.deserializeAttachment();
    return isSocketAttachment(attachment) ? attachment.connected_at : null;
  }

  private async dropped(socket: WebSocket): Promise<void> {
    if (this.isViewer(socket)) {
      this.viewers.close(socket);
      return;
    }
    this.failAll("interrupted", CONNECTION_LOST, socket);
    this.viewers.statusChanged();
    // A replacement connects before the old socket's close is delivered, so
    // "was that the last one?" is the question, not "did one close?".
    if (this.daemonSockets().some((other) => other !== socket)) {
      return;
    }
    const hostId = await this.host();
    if (!hostId) {
      return;
    }
    // It was alive until this moment, so "last seen" is now.
    await touchHostSeen(this.db(), hostId);
    await setHostStatus(this.db(), hostId, "offline");
  }

  /** Settles every waiting request, or only those owed by one socket. */
  private failAll(
    reason: RelayFailureReason,
    message: string,
    socket?: WebSocket
  ): void {
    const ids = [...this.pending]
      .filter(([, entry]) => socket === undefined || entry.socket === socket)
      .map(([id]) => id);
    for (const id of ids) {
      this.fail(id, reason, message);
    }
  }

  /**
   * Fails one request whose command may still be running on the machine, and
   * remembers its id so a cancel follows when the machine next connects.
   */
  private fail(id: string, reason: RelayFailureReason, message: string): void {
    if (!this.pending.has(id)) {
      return;
    }
    this.ctx.waitUntil(this.rememberOrphans([id]));
    this.finish(id, {
      code: null,
      message,
      ok: false,
      reason,
      result_json: null,
    });
  }

  private finish(id: string, outcome: RelayOutcome): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    clearInterval(entry.poll);
    entry.settle(outcome);
  }

  /** Waiting requests re-check the socket's heartbeat, so a dead peer is noticed before TCP. */
  private checkStale(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    const last = this.lastHeartbeatAt(entry.socket);
    if (last === null || Date.now() - last <= STALE_AFTER_MS) {
      return;
    }
    try {
      entry.socket.close(CLOSE_STALE, "heartbeat went stale");
    } catch {
      // Already closing.
    }
    this.fail(id, "stale", STALE_MESSAGE);
  }

  /** Ids whose caller is gone, kept in storage because the machine may return after a hibernation. */
  private async rememberOrphans(ids: readonly string[]): Promise<void> {
    const stored = (await this.ctx.storage.get<string[]>(ORPHANS_KEY)) ?? [];
    await this.ctx.storage.put(
      ORPHANS_KEY,
      [...stored, ...ids].slice(-MAX_ORPHANS)
    );
  }

  /** Cancels the commands whose caller was lost, on the socket that just arrived. */
  private async cancelOrphans(socket: WebSocket): Promise<void> {
    const orphaned = (await this.ctx.storage.get<string[]>(ORPHANS_KEY)) ?? [];
    if (orphaned.length === 0) {
      return;
    }
    await this.ctx.storage.delete(ORPHANS_KEY);
    for (const targetId of orphaned) {
      try {
        socket.send(
          JSON.stringify({
            id: crypto.randomUUID(),
            op: "cancel",
            target_id: targetId,
          })
        );
      } catch {
        // The new socket went too; the bounded loss is the rest of the list.
        return;
      }
    }
  }

  /**
   * One command at a time, the way the daemon itself serialises `exec`. Queueing
   * here keeps the second command's timeout honest: it starts when the command
   * starts, not when it was asked for.
   */
  private enqueueExec(run: () => Promise<RelayOutcome>): Promise<RelayOutcome> {
    const result = this.execQueue.then(run, run);
    this.execQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * The per-op check against the one desktop controller. Under a person's
   * control, and while their clipboard is being cleared, every agent op but
   * `cancel` is refused: `exec` runs with DISPLAY set, so it could read the
   * screen or clipboard behind the tools. Once the machine has failed enough
   * clears in a row, commands and file transfers run again.
   */
  private decide(
    op: string,
    principal: ComputerPrincipal,
    now: number
  ): Decision {
    const lease = this.currentLease(now);
    return principal.kind === "agent"
      ? decideForAgent({ lease, op, principal })
      : decideForPerson({ lease, op, principal });
  }

  /** An exec that waited its turn is checked again: a person may have taken the desktop meanwhile. */
  private async sendExecIfAllowed(
    message: Record<string, unknown>,
    principal: ComputerPrincipal
  ): Promise<RelayOutcome> {
    const late = this.decide("exec", principal, Date.now());
    if (late.kind === "refuse") {
      return refusal(late.reason, late.message);
    }
    return await this.dispatch(message);
  }

  /**
   * The controller as of `now`. An idle agent simply lets go; a person who went
   * quiet leaves the desktop clearing. Every call while clearing retries the clear.
   */
  private currentLease(now: number): StoredLease | undefined {
    const { lease } = this;
    if (lease?.kind === "clearing") {
      this.clearClipboard();
      return lease;
    }
    if (lease === undefined || now < leaseExpiresAt(lease)) {
      return lease;
    }
    if (lease.holder.kind === "agent") {
      this.setLease(undefined);
      return;
    }
    return this.startClearing();
  }

  private setLease(next: StoredLease | undefined): void {
    this.lease = next;
    this.viewers.statusChanged();
    this.leasePersistedAt = next?.kind === "held" ? next.lastOpAt : 0;
    this.ctx.waitUntil(
      next === undefined
        ? this.ctx.storage.delete(LEASE_KEY)
        : this.ctx.storage.put(LEASE_KEY, next)
    );
    if (next?.kind === "held") {
      this.ctx.waitUntil(this.armAlarm(this.currentSocket() !== undefined));
    }
  }

  /** Wakes for the next presence check, or for a held lease's expiry, whichever comes first. */
  private async armAlarm(connected: boolean): Promise<void> {
    const now = Date.now();
    const wakes: number[] = [];
    if (connected || this.viewerSockets().length > 0) {
      wakes.push(now + LAST_SEEN_ALARM_MS);
    }
    if (this.lease?.kind === "held") {
      wakes.push(leaseExpiresAt(this.lease));
    }
    if (wakes.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...wakes));
    }
  }

  /** A person's control ends here; nobody drives or reads the desktop until the clear is confirmed. */
  private startClearing(): StoredLease {
    const clearing: StoredLease = { failedClears: 0, kind: "clearing" };
    this.setLease(clearing);
    this.clearClipboard();
    return clearing;
  }

  /**
   * Takes or renews the hold for `principal`. The holder recorded stays the one
   * already holding it, so a renewal by an unnamed agent keeps the agent's id.
   * A new holder is written at once; a renewal only when the stored time is stale.
   */
  private renewLease(principal: ComputerPrincipal, now: number): HeldLease {
    const previous = this.lease;
    if (previous?.kind === "held" && holdsControl(previous.holder, principal)) {
      const next: HeldLease = {
        holder: previous.holder,
        kind: "held",
        lastOpAt: now,
      };
      if (now - this.leasePersistedAt >= LEASE_PERSIST_INTERVAL_MS) {
        this.setLease(next);
      } else {
        this.lease = next;
      }
      return next;
    }
    const next: HeldLease = { holder: principal, kind: "held", lastOpAt: now };
    this.setLease(next);
    return next;
  }

  /** One clear at a time: everyone waiting on the desktop waits on the same one. */
  private clearClipboard(): Promise<boolean> {
    if (this.clearInFlight === undefined) {
      const clearing = this.sendClear().finally(() => {
        this.clearInFlight = undefined;
      });
      this.clearInFlight = clearing;
      this.ctx.waitUntil(clearing);
    }
    return this.clearInFlight;
  }

  /**
   * Clears both selections, then ends the clearing state. A clear that fails
   * leaves the desktop clearing on purpose; the next op, alarm or reconnect sends
   * it again. Only failures from a machine that answered count towards letting
   * commands through: an offline machine says nothing about its clipboard.
   */
  private async sendClear(): Promise<boolean> {
    // With no desktop running there is no X server, so no selection is left for anyone to read.
    if (this.hello?.capabilities.desktop === true) {
      const outcome = await this.dispatch({
        ...CLEAR_CLIPBOARD,
        timeout_ms: DESKTOP_CLIPBOARD_TIMEOUT_MS,
      });
      const nothingToClear =
        outcome.code !== null && NOTHING_TO_CLEAR_CODES.has(outcome.code);
      if (!(outcome.ok || nothingToClear)) {
        if (outcome.code !== null || outcome.reason === "timeout") {
          this.countFailedClear();
        }
        return false;
      }
    }
    if (this.lease?.kind === "clearing") {
      this.setLease(undefined);
    }
    return true;
  }

  private countFailedClear(): void {
    if (this.lease?.kind !== "clearing") {
      return;
    }
    this.setLease({
      failedClears: this.lease.failedClears + 1,
      kind: "clearing",
    });
  }

  private desktopUnavailableMessage(): string {
    const reason = this.hello?.capabilities.desktop_unavailable_reason;
    return `The computer has no desktop running${reason ? `: ${reason}` : ""}`;
  }

  private async dispatch(
    message: Record<string, unknown>
  ): Promise<RelayOutcome> {
    await this.load();
    const socket = this.currentSocket();
    if (!socket) {
      return {
        code: null,
        message: await this.offlineReason(),
        ok: false,
        reason: "offline",
        result_json: null,
      };
    }
    const id =
      typeof message.id === "string" ? message.id : crypto.randomUUID();
    if (this.pending.has(id)) {
      return {
        code: null,
        message: "A request with this id is already in flight.",
        ok: false,
        reason: "duplicate_id",
        result_json: null,
      };
    }
    const outcome = new Promise<RelayOutcome>((resolve) => {
      // Registered before the send, so an answer that arrives at once has somewhere to land.
      const timer = setTimeout(
        () => this.fail(id, "timeout", TIMED_OUT),
        deadlineFor(message)
      );
      const poll = setInterval(() => this.checkStale(id), STALENESS_POLL_MS);
      this.pending.set(id, { poll, settle: resolve, socket, timer });
    });
    try {
      socket.send(JSON.stringify({ ...message, id }));
    } catch {
      this.fail(id, "interrupted", CONNECTION_LOST);
    }
    return await outcome;
  }

  /**
   * The one message an agent sees when its computer is not there. It names the
   * host and when it was last heard from, because the fix is the reader's to make.
   */
  private async offlineReason(): Promise<string> {
    const hostId = await this.host();
    const host = hostId
      ? await getHostByIdUnscoped(this.db(), hostId)
      : undefined;
    const when = host?.lastSeenAt
      ? describeAge(host.lastSeenAt, Date.now())
      : "never connected";
    const which = host ? `"${host.name}"` : "for this agent";
    return `The computer host ${which} is offline (${when}). Start the container and try again.`;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? "" : "s"} ago`;

/** "12 minutes ago" - the shape the offline reason reads best in. */
const describeAge = (since: Date, now: number): string => {
  const elapsed = Math.max(0, now - since.getTime());
  if (elapsed < MINUTE_MS) {
    return "less than a minute ago";
  }
  if (elapsed < HOUR_MS) {
    return plural(Math.round(elapsed / MINUTE_MS), "minute");
  }
  if (elapsed < DAY_MS) {
    return plural(Math.round(elapsed / HOUR_MS), "hour");
  }
  return plural(Math.round(elapsed / DAY_MS), "day");
};
