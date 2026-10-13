import { DurableObject } from "cloudflare:workers";
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
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type HelloMessage,
  HelloMessageSchema,
  RELAY_GRACE_MS,
  STALE_AFTER_MS,
  STALENESS_POLL_MS,
} from "./protocol";
import {
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
} from "./remote-client";

/**
 * One self-hosted host's daemon connection (`idFromName(hostId)`). The container
 * dials out to `/api/computer-hosts/connect`, that route hands the upgraded
 * socket here, and every computer operation for an agent on this host is written
 * to it. Ported from TrueForge's `RemoteComputerDO`, with the desktop lease,
 * human takeover and clipboard clearing left out.
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
  | "duplicate_id";

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
  hostname: string | null;
  version: string | null;
  workdir: string | null;
}

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
  private readonly pending = new Map<string, Pending>();
  /** The tail of the exec queue: one command in flight per host, as in the DO backend. */
  private execQueue: Promise<unknown> = Promise.resolve();

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

    for (const existing of this.ctx.getWebSockets()) {
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
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: ArrayBuffer | string
  ): Promise<void> {
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

  /** Presence while connected: the last-seen column moves once a minute, not per heartbeat. */
  override async alarm(): Promise<void> {
    await this.load();
    if (this.currentSocket() === undefined) {
      return;
    }
    const hostId = await this.host();
    if (hostId) {
      await touchHostSeen(this.db(), hostId);
    }
    await this.ctx.storage.setAlarm(Date.now() + LAST_SEEN_ALARM_MS);
  }

  /**
   * One protocol message to the daemon, resolved with its outcome. Never throws:
   * a host with no socket answers `offline` here and now, rather than making the
   * caller wait for a timeout.
   */
  async request(message: Record<string, unknown>): Promise<RelayOutcome> {
    await this.load();
    if (message.op === "exec") {
      return await this.enqueueExec(() => this.dispatch(message));
    }
    return await this.dispatch(message);
  }

  /** The connection state and what the daemon said about itself in its hello. */
  async status(): Promise<RelayStatus> {
    await this.load();
    return {
      capabilities: this.hello?.capabilities ?? null,
      connected: this.currentSocket() !== undefined,
      hostname: this.hello?.hostname ?? null,
      version: this.hello?.version ?? null,
      workdir: this.hello?.workdir ?? null,
    };
  }

  /**
   * Closes the daemon with 4401, which the client treats as terminal, and fails
   * what is in flight. Called when the host's credential is revoked.
   */
  revoke(): void {
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
    this.failAll("interrupted", CONNECTION_LOST, socket);
    // A replacement connects before the old socket's close is delivered, so
    // "was that the last one?" is the question, not "did one close?".
    if (this.ctx.getWebSockets().some((other) => other !== socket)) {
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
