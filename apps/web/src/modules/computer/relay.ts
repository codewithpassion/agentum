import { DurableObject } from "cloudflare:workers";
import { createDb, type Db } from "#/db/client";
import { getHostByIdUnscoped, setHostStatus, touchHostSeen } from "./hosts";
import {
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
} from "./remote-client";

/**
 * One self-hosted host's daemon connection (`idFromName(hostId)`), and the
 * only thing in Agentum that holds it: the container dials *out* to
 * `/api/computer-hosts/connect`, that route hands the upgraded socket here,
 * and every computer operation for an agent on this host is written to it
 * (docs/plan-computer-backends.md §6).
 *
 * The socket is accepted with the **hibernation API**, so an idle daemon costs
 * nothing and survives this object being evicted. The pending map is in memory
 * on purpose: an eviction can only happen while nothing is pending, and a
 * hibernated instance that loses one would have had nothing to lose.
 *
 * Heartbeats are answered in `webSocketMessage` rather than with
 * `setWebSocketAutoResponse`. The auto-response keeps the object asleep, which
 * is cheaper - but it would also freeze `last_seen_at` for as long as the
 * daemon stays connected, and that column is what the host page shows and what
 * the offline reason below quotes. One D1 write every 30 seconds per connected
 * host is the price of that number being true.
 */

const WEBSOCKET_UPGRADE_REQUIRED = 426;
const BAD_REQUEST = 400;

/** "Service restart" - the closest code for "another daemon took your place". */
const REPLACED = 1012;

/** The host id this instance belongs to, learned from the connect route. */
const HOST_KEY = "hostId";
/** What the daemon said about itself in `hello`. */
const DAEMON_KEY = "daemon";

/**
 * Added to the operation's own timeout before this side gives up, so the
 * daemon's answer - including its own "timed out after 600 s" - wins the race
 * whenever the daemon is still there at all.
 */
const REQUEST_GRACE_MS = 10_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const TIMED_OUT =
  "The computer did not answer in time. It may be busy or its connection may have dropped.";

const CONNECTION_LOST =
  "The connection to the computer closed before it answered. Check that the container is still running and try again.";

interface DaemonInfo {
  hostname: string | null;
  version: string | null;
}

interface Pending {
  reject: (error: Error) => void;
  resolve: (reply: unknown) => void;
  /** Which connection owes this answer; a replaced socket takes only its own. */
  socket: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/**
 * The connect route addresses this object by name *and* puts the host id in
 * the path, because a Durable Object cannot be relied on to read back the name
 * it was reached by - the same reason the agent router is told its workspace.
 */
const hostIdFromUrl = (url: string): string | null => {
  const last = new URL(url).pathname.split("/").pop();
  return last ? decodeURIComponent(last) : null;
};

/**
 * How long to wait for one reply: what the message asked for, capped the way
 * the remote client caps it, plus the grace above.
 */
const deadlineFor = (message: Record<string, unknown>): number => {
  const asked = message.timeoutMs;
  const requested =
    typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, REMOTE_EXEC_MAX_TIMEOUT_MS)
      : REMOTE_EXEC_DEFAULT_TIMEOUT_MS;
  return requested + REQUEST_GRACE_MS;
};

export class ComputerRelay extends DurableObject<Env> {
  private database: Db | null = null;
  private hostId: string | null = null;
  private readonly pending = new Map<string, Pending>();
  /** The tail of the exec queue: one command in flight per host, as in the DO backend. */
  private execQueue: Promise<unknown> = Promise.resolve();

  private db(): Db {
    this.database ??= createDb(this.env.DB);
    return this.database;
  }

  private async host(): Promise<string | null> {
    this.hostId ??= (await this.ctx.storage.get<string>(HOST_KEY)) ?? null;
    return this.hostId;
  }

  /**
   * The daemon's upgrade, handed over by the connect route after it has
   * resolved the token to this host. Only one daemon per host: a new
   * connection replaces the old one, which is also what makes restarting a
   * container safe while the old socket is still half-open.
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
    this.hostId = hostId;
    await this.ctx.storage.put(HOST_KEY, hostId);

    for (const existing of this.ctx.getWebSockets()) {
      existing.close(REPLACED, "Replaced by a newer connection for this host.");
    }

    // biome-ignore lint/correctness/noUndeclaredVariables: WebSocketPair is a Workers runtime global
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    socket: WebSocket,
    message: ArrayBuffer | string
  ): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      // A daemon that speaks nonsense is not worth dropping the socket over;
      // the request that was waiting for an answer times out on its own.
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }

    if (parsed.type === "hello") {
      await this.onHello(parsed);
      return;
    }
    if (parsed.type === "heartbeat") {
      socket.send(JSON.stringify({ type: "heartbeat_ack" }));
      await this.touch();
      return;
    }
    if (typeof parsed.id === "string") {
      this.settle(parsed.id, parsed);
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.dropped(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.dropped(socket);
  }

  /**
   * One protocol message to the daemon, resolved with its `{ id, result }`
   * envelope. A host with no socket fails here and now with a reason a person
   * can act on, rather than making the agent wait for a timeout.
   */
  async request(message: Record<string, unknown>): Promise<unknown> {
    if (this.ctx.getWebSockets().length === 0) {
      throw new Error(await this.offlineReason());
    }
    if (message.op === "exec") {
      return await this.enqueueExec(() => this.dispatch(message));
    }
    return await this.dispatch(message);
  }

  /** What the host page shows next to the status dot. */
  async status(): Promise<{
    connected: boolean;
    hostname?: string;
    version?: string;
  }> {
    const daemon = await this.ctx.storage.get<DaemonInfo>(DAEMON_KEY);
    return {
      connected: this.ctx.getWebSockets().length > 0,
      ...(daemon?.hostname ? { hostname: daemon.hostname } : {}),
      ...(daemon?.version ? { version: daemon.version } : {}),
    };
  }

  private async onHello(hello: Record<string, unknown>): Promise<void> {
    await this.ctx.storage.put<DaemonInfo>(DAEMON_KEY, {
      hostname: typeof hello.hostname === "string" ? hello.hostname : null,
      version: typeof hello.version === "string" ? hello.version : null,
    });
    const hostId = await this.host();
    if (!hostId) {
      return;
    }
    await setHostStatus(this.db(), hostId, "ready");
    await touchHostSeen(this.db(), hostId);
  }

  private async touch(): Promise<void> {
    const hostId = await this.host();
    if (hostId) {
      await touchHostSeen(this.db(), hostId);
    }
  }

  private settle(id: string, reply: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      // An answer to a request that already timed out, or to one a previous
      // connection made. Dropping it is the only safe thing: nobody is waiting.
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  }

  private async dropped(socket: WebSocket): Promise<void> {
    for (const [id, entry] of this.pending) {
      if (entry.socket !== socket) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(CONNECTION_LOST));
    }

    // A replacement connects before the old socket's close is delivered, so
    // "was that the last one?" is the question, not "did one close?".
    if (this.ctx.getWebSockets().some((other) => other !== socket)) {
      return;
    }
    const hostId = await this.host();
    if (!hostId) {
      return;
    }
    // It was alive until this moment, so "last seen" is now - which is what
    // makes the offline reason accurate the second after a container stops.
    await touchHostSeen(this.db(), hostId);
    await setHostStatus(this.db(), hostId, "offline");
  }

  /**
   * One command at a time, the way the Durable Object backend behaves and the
   * way the daemon itself serialises `exec`. Queueing here rather than there
   * is what keeps the second command's timeout honest: it starts when the
   * command starts, not when it was asked for.
   */
  private enqueueExec(run: () => Promise<unknown>): Promise<unknown> {
    const result = this.execQueue.then(run, run);
    this.execQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async dispatch(message: Record<string, unknown>): Promise<unknown> {
    const [socket] = this.ctx.getWebSockets();
    if (!socket) {
      throw new Error(await this.offlineReason());
    }
    const id =
      typeof message.id === "string" ? message.id : crypto.randomUUID();
    try {
      socket.send(JSON.stringify({ ...message, id }));
    } catch (error) {
      throw new Error(await this.offlineReason(), { cause: error });
    }

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(TIMED_OUT));
      }, deadlineFor(message));
      this.pending.set(id, { reject, resolve, socket, timer });
    });
  }

  /**
   * The one message an agent sees when its computer is not there. It names the
   * host and when it was last heard from, because the fix - start the
   * container - is the reader's to carry out.
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
