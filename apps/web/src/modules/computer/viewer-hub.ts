import { z } from "zod";
import { fromBase64 } from "./desktop";
import { relayFailure } from "./desktop-failure";
import {
  DESKTOP_SCREENSHOT_TIMEOUT_MS,
  DesktopInputRequestSchema,
  DesktopScreenshotResultPayloadSchema,
  desktopInputTimeoutMs,
} from "./protocol";
import type { ComputerPrincipal, RelayOutcome, RelayStatus } from "./relay";

/**
 * The people watching one host's desktop over a WebSocket, and the pump that
 * feeds them. The relay owns the sockets and the lease; this owns what is sent
 * on the viewer sockets.
 *
 * Server to viewer:
 *   - binary: a 4-byte big-endian frame id, then the JPEG;
 *   - `{"t":"status", ...}`: the shape of GET /desktop, for this viewer;
 *   - `{"t":"problem","code","message"}`: no frame can be made (offline,
 *     desktop_unavailable, human_in_control, clearing, desktop_failed);
 *   - `{"t":"error","code","message"}`: input was refused (lease_required, ...).
 * Viewer to server:
 *   - `{"t":"ack","id":n}`: frames up to n are on screen;
 *   - `{"t":"input","actions":[...]}`: needs the human lease.
 */

/** The relay's internal address for a viewer upgrade; daemon sockets only ever arrive at /hosts/:id. */
export const VIEWER_PATH = "/viewer";
/** Set by the Worker from the signed-in session; the relay trusts it only on VIEWER_PATH. */
export const VIEWER_USER_HEADER = "x-agentum-viewer-user";
export const VIEWER_TAG = "viewer";

/** Frames a viewer may hold un-acked before it is skipped. */
export const MAX_UNACKED_FRAMES = 2;
/** At most one capture is started per this many milliseconds: about 16 fps. */
export const FRAME_INTERVAL_MS = 60;
/** Captures that may be waiting on the daemon at once; the daemon has two screenshot slots. */
const MAX_CAPTURES_IN_FLIGHT = 2;
/** How long to leave a failing desktop alone before asking again. */
export const RETRY_AFTER_FAILURE_MS = 1500;
/** The pump's pace while the screen is not changing; a change or input brings back FRAME_INTERVAL_MS. */
export const IDLE_INTERVAL_MS = 250;
const FRAME_HEADER_BYTES = 4;
const HASH_ALGORITHM = "SHA-256";

export interface ViewerAttachment {
  readonly kind: "viewer";
  readonly userId: string;
}

export const isViewerAttachment = (value: unknown): value is ViewerAttachment =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === "viewer" &&
  "userId" in value &&
  typeof value.userId === "string";

const ClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ id: z.number().int().nonnegative(), t: z.literal("ack") }),
  z.object({
    actions: DesktopInputRequestSchema.shape.actions,
    t: z.literal("input"),
  }),
]);

/** Whether `userId` is the person holding the desktop right now. */
const youHold = (status: RelayStatus, userId: string): boolean => {
  const { control } = status;
  return (
    control !== null &&
    control.holder.kind === "human" &&
    control.holder.userId === userId
  );
};

/** What GET /desktop answers, and what a viewer socket is pushed, for one person. */
export const desktopStatusBody = (status: RelayStatus, userId: string) => ({
  connected: status.connected,
  control: status.control,
  desktop: status.capabilities?.desktop === true,
  desktopUnavailableReason:
    status.capabilities?.desktop_unavailable_reason ?? null,
  youHaveControl: youHold(status, userId),
});

/** What the hub needs from the relay that owns it. */
export interface ViewerHost {
  request: (
    message: Record<string, unknown>,
    principal: ComputerPrincipal
  ) => Promise<RelayOutcome>;
  status: () => Promise<RelayStatus>;
  /** Every viewer socket the runtime still holds, including ones this object forgot. */
  viewerSockets: () => WebSocket[];
}

interface Viewer {
  inputChain: Promise<void>;
  lastHash: string | null;
  lastStatus: string | null;
  problem: string | null;
  readonly socket: WebSocket;
  /** Ids sent and not yet acked, oldest first. */
  unacked: number[];
  readonly userId: string;
}

export interface ViewerHubOptions {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const hashOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await crypto.subtle.digest(HASH_ALGORITHM, bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

const frameMessage = (id: number, jpeg: Uint8Array): ArrayBuffer => {
  const message = new Uint8Array(FRAME_HEADER_BYTES + jpeg.byteLength);
  new DataView(message.buffer).setUint32(0, id);
  message.set(jpeg, FRAME_HEADER_BYTES);
  return message.buffer;
};

export class DesktopViewers {
  private readonly host: ViewerHost;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly viewers = new Map<WebSocket, Viewer>();
  private running = false;
  private nextFrameId = 1;
  private capturesInFlight = 0;
  private retryAt = 0;
  private statusQueued = false;

  constructor(host: ViewerHost, options: ViewerHubOptions = {}) {
    this.host = host;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get pumping(): boolean {
    return this.running;
  }

  /** A viewer socket was accepted (or woke from hibernation): tell it where things stand and start the pump. */
  open(socket: WebSocket): void {
    const viewer = this.adopt(socket);
    if (viewer) {
      this.statusChanged();
    }
  }

  /** Takes sockets that outlived this object's memory (hibernation) back into the pump. */
  adoptAll(sockets: readonly WebSocket[]): void {
    for (const socket of sockets) {
      this.adopt(socket);
    }
  }

  close(socket: WebSocket): void {
    this.viewers.delete(socket);
  }

  message(socket: WebSocket, raw: ArrayBuffer | string): void {
    const viewer = this.adopt(socket);
    if (!viewer || typeof raw !== "string") {
      return;
    }
    const parsed = ClientMessageSchema.safeParse(parseJson(raw));
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.t === "ack") {
      viewer.unacked = viewer.unacked.filter((id) => id > message.id);
      return;
    }
    this.retryAt = 0;
    viewer.inputChain = viewer.inputChain.then(() =>
      this.runInput(viewer, message.actions)
    );
  }

  /** Control, connection or capabilities changed: push every viewer its status and let frames resume. */
  statusChanged(): void {
    // After a hibernation or eviction the sockets outlive this object's memory.
    this.adoptAll(this.host.viewerSockets());
    this.retryAt = 0;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: statusQueued is reset by the microtask below, which the checker cannot see
    if (this.statusQueued || this.viewers.size === 0) {
      return;
    }
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      this.pushStatus().catch(() => undefined);
    });
  }

  /** One pump step: start a capture if a viewer can take a frame. Never throws. */
  async tick(): Promise<void> {
    if (
      this.capturesInFlight >= MAX_CAPTURES_IN_FLIGHT ||
      this.clock() < this.retryAt
    ) {
      return;
    }
    const waiting = [...this.viewers.values()].filter(
      (viewer) => viewer.unacked.length < MAX_UNACKED_FRAMES
    );
    if (waiting.length === 0) {
      return;
    }
    this.capturesInFlight += 1;
    try {
      await this.capture(waiting);
    } catch {
      this.retryAt = this.clock() + RETRY_AFTER_FAILURE_MS;
    } finally {
      this.capturesInFlight -= 1;
    }
  }

  private adopt(socket: WebSocket): Viewer | undefined {
    const known = this.viewers.get(socket);
    if (known) {
      return known;
    }
    const attachment: unknown = socket.deserializeAttachment();
    if (!isViewerAttachment(attachment)) {
      return;
    }
    const viewer: Viewer = {
      inputChain: Promise.resolve(),
      lastHash: null,
      lastStatus: null,
      problem: null,
      socket,
      unacked: [],
      userId: attachment.userId,
    };
    this.viewers.set(socket, viewer);
    this.ensurePump();
    return viewer;
  }

  private ensurePump(): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: running is cleared by runPump, which the checker cannot see
    if (this.running) {
      return;
    }
    this.running = true;
    this.runPump().catch(() => undefined);
  }

  private async runPump(): Promise<void> {
    try {
      while (this.viewers.size > 0) {
        // Not awaited: the next capture may start while this one is still on the wire.
        this.tick().catch(() => undefined);
        // biome-ignore lint/performance/noAwaitInLoops: the pump paces itself one interval at a time
        await this.sleep(FRAME_INTERVAL_MS);
      }
    } finally {
      this.running = false;
    }
  }

  private send(viewer: Viewer, data: string | ArrayBuffer): void {
    try {
      viewer.socket.send(data);
    } catch {
      this.viewers.delete(viewer.socket);
    }
  }

  private sendJson(viewer: Viewer, body: Record<string, unknown>): void {
    this.send(viewer, JSON.stringify(body));
  }

  private problemFor(viewer: Viewer, code: string, message: string): void {
    if (viewer.problem === code) {
      return;
    }
    viewer.problem = code;
    this.sendJson(viewer, { code, message, t: "problem" });
  }

  private async pushStatus(): Promise<void> {
    const status = await this.host.status();
    for (const viewer of [...this.viewers.values()]) {
      const body = JSON.stringify({
        ...desktopStatusBody(status, viewer.userId),
        t: "status",
      });
      if (body !== viewer.lastStatus) {
        viewer.lastStatus = body;
        this.send(viewer, body);
      }
    }
  }

  /**
   * Another person's screen is theirs alone: while a person holds the desktop,
   * only that person is shown frames, exactly as the HTTP screenshot refuses.
   */
  private async allowedAmong(viewers: readonly Viewer[]): Promise<Viewer[]> {
    const { control } = await this.host.status();
    const blockedBy =
      control !== null && control.holder.kind === "human"
        ? control.holder.userId
        : null;
    const allowed: Viewer[] = [];
    for (const viewer of viewers) {
      if (blockedBy !== null && viewer.userId !== blockedBy) {
        this.problemFor(
          viewer,
          "human_in_control",
          "Another person is in control of this desktop."
        );
      } else {
        allowed.push(viewer);
      }
    }
    return allowed;
  }

  private async capture(waiting: readonly Viewer[]): Promise<void> {
    const [asking] = await this.allowedAmong(waiting);
    if (!asking) {
      return;
    }
    const outcome = await this.host.request(
      {
        op: "desktop_screenshot",
        quality: null,
        timeout_ms: DESKTOP_SCREENSHOT_TIMEOUT_MS,
      },
      { kind: "human", userId: asking.userId }
    );
    // Re-read after the wait: control may have changed hands while the frame was on its way.
    const recipients = await this.allowedAmong(
      [...this.viewers.values()].filter(
        (viewer) => viewer.unacked.length < MAX_UNACKED_FRAMES
      )
    );
    if (!outcome.ok) {
      const failure = relayFailure(outcome);
      this.retryAt = this.clock() + RETRY_AFTER_FAILURE_MS;
      for (const viewer of recipients) {
        this.problemFor(viewer, failure.error, failure.message);
      }
      return;
    }
    const payload = DesktopScreenshotResultPayloadSchema.safeParse(
      parseJson(outcome.result_json)
    );
    if (!payload.success) {
      this.retryAt = this.clock() + RETRY_AFTER_FAILURE_MS;
      for (const viewer of recipients) {
        this.problemFor(
          viewer,
          "desktop_failed",
          "The computer sent a reply this server cannot read."
        );
      }
      return;
    }
    const jpeg = fromBase64(payload.data.data_b64);
    const hash = await hashOf(jpeg);
    // A viewer showing a problem gets the frame even if it is the one it had before the problem.
    const changed = recipients.filter(
      (viewer) => viewer.lastHash !== hash || viewer.problem !== null
    );
    if (changed.length === 0) {
      // Nothing moved on screen: look less often until something does.
      if (recipients.length > 0) {
        this.retryAt = this.clock() + IDLE_INTERVAL_MS;
      }
      return;
    }
    this.retryAt = 0;
    const id = this.nextFrameId;
    this.nextFrameId += 1;
    const frame = frameMessage(id, jpeg);
    for (const viewer of changed) {
      viewer.lastHash = hash;
      viewer.problem = null;
      viewer.unacked.push(id);
      this.send(viewer, frame);
    }
  }

  private async runInput(
    viewer: Viewer,
    actions: z.infer<typeof DesktopInputRequestSchema>["actions"]
  ): Promise<void> {
    const outcome = await this.host.request(
      {
        actions,
        op: "desktop_input",
        timeout_ms: desktopInputTimeoutMs(actions),
      },
      { kind: "human", userId: viewer.userId }
    );
    if (!outcome.ok) {
      const failure = relayFailure(outcome);
      this.sendJson(viewer, {
        code: failure.error,
        message: failure.message,
        t: "error",
      });
    }
  }
}

function parseJson(json: string | null): unknown {
  try {
    return JSON.parse(json ?? "null");
  } catch {
    return null;
  }
}
