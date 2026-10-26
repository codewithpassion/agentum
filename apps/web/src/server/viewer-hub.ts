// The people watching one machine's desktop over a WebSocket, and the pump that
// feeds them. The relay owns the sockets and the desktop lease; this owns what is
// sent on the viewer sockets. Ported from agentum `modules/computer/viewer-hub.ts`
// as a factory over a host port, so bun can test it with fake sockets and timers.
//
// Server to viewer:
//   - binary: a 4-byte big-endian frame id, then the JPEG;
//   - `{"t":"status", ...}`: the shape of GET /desktop, for this viewer;
//   - `{"t":"problem","code","message"}`: no frame can be made (offline,
//     desktop_unavailable, human_in_control, clearing, desktop_failed);
//   - `{"t":"error","code","message"}`: input was refused (lease_required, ...).
// Viewer to server:
//   - `{"t":"ack","id":n}`: frames up to n are on screen;
//   - `{"t":"input","actions":[...]}`: needs the human lease.

import {
  type DesktopInputRequest,
  DesktopInputRequestSchema,
  type DesktopScreenshotRequest,
  DesktopScreenshotResultPayloadSchema,
} from "@repo/protocol/computer";
import type {
  ComputerOutcome,
  ComputerPrincipal,
  ComputerStatus,
} from "@repo/services/machines/types";
import { z } from "zod";
import { relayFailure } from "./desktop-failure.ts";

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

/** The part of a WebSocket the hub uses. Tests pass fakes, so the hub never touches a real socket. */
export interface ViewerSocket {
  deserializeAttachment: () => unknown;
  send: (data: string | ArrayBuffer) => void;
}

/** What the hub needs from the relay that owns it. */
export interface ViewerHost<S extends ViewerSocket> {
  desktopInput: (
    principal: ComputerPrincipal,
    input: Omit<DesktopInputRequest, "op">
  ) => Promise<ComputerOutcome>;
  desktopScreenshot: (
    principal: ComputerPrincipal,
    input: Omit<DesktopScreenshotRequest, "op">
  ) => Promise<ComputerOutcome>;
  status: () => Promise<ComputerStatus>;
  /** Every viewer socket the runtime still holds, including ones the hub forgot. */
  viewerSockets: () => S[];
}

export interface ViewerHubOptions {
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ViewerHub<S extends ViewerSocket> {
  /** Takes sockets that outlived the hub's memory (hibernation) back into the pump. */
  adoptAll: (sockets: readonly S[]) => void;
  close: (socket: S) => void;
  message: (socket: S, raw: ArrayBuffer | string) => void;
  /** A viewer socket was accepted (or woke from hibernation): tell it where things stand and start the pump. */
  open: (socket: S) => void;
  readonly pumping: boolean;
  /** Control, connection or capabilities changed: push every viewer its status and let frames resume. */
  statusChanged: () => void;
  /** One pump step: start a capture if a viewer can take a frame. Never throws. */
  tick: () => Promise<void>;
  readonly viewerCount: number;
}

interface Viewer<S extends ViewerSocket> {
  inputChain: Promise<void>;
  lastHash: string | null;
  lastStatus: string | null;
  problem: string | null;
  readonly socket: S;
  /** Ids sent and not yet acked, oldest first. */
  unacked: number[];
  readonly userId: string;
}

const ClientMessageSchema = z.discriminatedUnion("t", [
  z.object({ id: z.number().int().nonnegative(), t: z.literal("ack") }),
  z.object({
    actions: DesktopInputRequestSchema.shape.actions,
    t: z.literal("input"),
  }),
]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Whether `userId` is the person holding the desktop right now. */
const youHold = (status: ComputerStatus, userId: string): boolean => {
  const { control } = status;
  return (
    control !== null &&
    control.holder.kind === "human" &&
    control.holder.userId === userId
  );
};

/** What GET /desktop answers, and what a viewer socket is pushed, for one person. */
export const desktopStatusBody = (status: ComputerStatus, userId: string) => ({
  connected: status.connected,
  control: status.control,
  desktop: status.capabilities?.desktop === true,
  desktopUnavailableReason:
    status.capabilities?.desktop_unavailable_reason ?? null,
  youHaveControl: youHold(status, userId),
});

const hashOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await crypto.subtle.digest(HASH_ALGORITHM, bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

/** The client sends the JPEG as base64; the frame carries the raw bytes. */
const decodeBase64 = (encoded: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));

const frameMessage = (
  id: number,
  jpeg: Uint8Array<ArrayBuffer>
): ArrayBuffer => {
  const message = new Uint8Array(FRAME_HEADER_BYTES + jpeg.byteLength);
  new DataView(message.buffer).setUint32(0, id);
  message.set(jpeg, FRAME_HEADER_BYTES);
  return message.buffer;
};

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export const createViewerHub = <S extends ViewerSocket>(
  host: ViewerHost<S>,
  options: ViewerHubOptions = {}
): ViewerHub<S> => {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const viewers = new Map<S, Viewer<S>>();
  let running = false;
  let nextFrameId = 1;
  let capturesInFlight = 0;
  let retryAt = 0;
  let statusQueued = false;

  const send = (viewer: Viewer<S>, data: string | ArrayBuffer): void => {
    try {
      viewer.socket.send(data);
    } catch {
      viewers.delete(viewer.socket);
    }
  };

  const sendJson = (viewer: Viewer<S>, body: Record<string, unknown>): void => {
    send(viewer, JSON.stringify(body));
  };

  const problemFor = (
    viewer: Viewer<S>,
    code: string,
    message: string
  ): void => {
    if (viewer.problem === code) {
      return;
    }
    viewer.problem = code;
    sendJson(viewer, { code, message, t: "problem" });
  };

  const adopt = (socket: S): Viewer<S> | undefined => {
    const known = viewers.get(socket);
    if (known) {
      return known;
    }
    const attachment: unknown = socket.deserializeAttachment();
    if (!isViewerAttachment(attachment)) {
      return;
    }
    const viewer: Viewer<S> = {
      inputChain: Promise.resolve(),
      lastHash: null,
      lastStatus: null,
      problem: null,
      socket,
      unacked: [],
      userId: attachment.userId,
    };
    viewers.set(socket, viewer);
    ensurePump();
    return viewer;
  };

  const adoptAll = (sockets: readonly S[]): void => {
    for (const socket of sockets) {
      adopt(socket);
    }
  };

  const pushStatus = async (): Promise<void> => {
    const status = await host.status();
    for (const viewer of [...viewers.values()]) {
      const body = JSON.stringify({
        ...desktopStatusBody(status, viewer.userId),
        t: "status",
      });
      if (body !== viewer.lastStatus) {
        viewer.lastStatus = body;
        send(viewer, body);
      }
    }
  };

  /**
   * Another person's screen is theirs alone: while a person holds the desktop,
   * only that person is shown frames, exactly as the HTTP screenshot refuses.
   */
  const allowedAmong = async (
    candidates: readonly Viewer<S>[]
  ): Promise<Viewer<S>[]> => {
    const { control } = await host.status();
    const blockedBy =
      control !== null && control.holder.kind === "human"
        ? control.holder.userId
        : null;
    const allowed: Viewer<S>[] = [];
    for (const viewer of candidates) {
      if (blockedBy !== null && viewer.userId !== blockedBy) {
        problemFor(
          viewer,
          "human_in_control",
          "Another person is in control of this desktop."
        );
      } else {
        allowed.push(viewer);
      }
    }
    return allowed;
  };

  const hasRoom = (viewer: Viewer<S>): boolean =>
    viewer.unacked.length < MAX_UNACKED_FRAMES;

  const capture = async (waiting: readonly Viewer<S>[]): Promise<void> => {
    const [asking] = await allowedAmong(waiting);
    if (!asking) {
      return;
    }
    const outcome = await host.desktopScreenshot(
      { kind: "human", userId: asking.userId },
      { quality: null }
    );
    // Re-read after the wait: control may have changed hands while the frame was on its way.
    const recipients = await allowedAmong(
      [...viewers.values()].filter(hasRoom)
    );
    if (!outcome.ok) {
      const failure = relayFailure(outcome);
      retryAt = clock() + RETRY_AFTER_FAILURE_MS;
      for (const viewer of recipients) {
        problemFor(viewer, failure.error, failure.message);
      }
      return;
    }
    const payload = DesktopScreenshotResultPayloadSchema.safeParse(
      parseJson(outcome.resultJson)
    );
    if (!payload.success) {
      retryAt = clock() + RETRY_AFTER_FAILURE_MS;
      for (const viewer of recipients) {
        problemFor(
          viewer,
          "desktop_failed",
          "The computer sent a reply this server cannot read."
        );
      }
      return;
    }
    const jpeg = decodeBase64(payload.data.data_b64);
    const hash = await hashOf(jpeg);
    // A viewer showing a problem gets the frame even if it is the one it had before the problem.
    const changed = recipients.filter(
      (viewer) => viewer.lastHash !== hash || viewer.problem !== null
    );
    if (changed.length === 0) {
      // Nothing moved on screen: look less often until something does.
      if (recipients.length > 0) {
        retryAt = clock() + IDLE_INTERVAL_MS;
      }
      return;
    }
    retryAt = 0;
    const id = nextFrameId;
    nextFrameId += 1;
    const frame = frameMessage(id, jpeg);
    for (const viewer of changed) {
      viewer.lastHash = hash;
      viewer.problem = null;
      viewer.unacked.push(id);
      send(viewer, frame);
    }
  };

  const tick = async (): Promise<void> => {
    if (capturesInFlight >= MAX_CAPTURES_IN_FLIGHT || clock() < retryAt) {
      return;
    }
    const waiting = [...viewers.values()].filter(hasRoom);
    if (waiting.length === 0) {
      return;
    }
    capturesInFlight += 1;
    try {
      await capture(waiting);
    } catch {
      retryAt = clock() + RETRY_AFTER_FAILURE_MS;
    } finally {
      capturesInFlight -= 1;
    }
  };

  const runPump = async (): Promise<void> => {
    try {
      while (viewers.size > 0) {
        // Not awaited: the next capture may start while this one is still on the wire.
        tick().catch(() => undefined);
        // biome-ignore lint/performance/noAwaitInLoops: the pump paces itself one interval at a time
        await sleep(FRAME_INTERVAL_MS);
      }
    } finally {
      running = false;
    }
  };

  const ensurePump = (): void => {
    if (running) {
      return;
    }
    running = true;
    runPump().catch(() => undefined);
  };

  const runInput = async (
    viewer: Viewer<S>,
    actions: DesktopInputRequest["actions"]
  ): Promise<void> => {
    const outcome = await host.desktopInput(
      { kind: "human", userId: viewer.userId },
      { actions }
    );
    if (!outcome.ok) {
      const failure = relayFailure(outcome);
      sendJson(viewer, {
        code: failure.error,
        message: failure.message,
        t: "error",
      });
    }
  };

  const statusChanged = (): void => {
    // After a hibernation or eviction the sockets outlive the hub's memory.
    adoptAll(host.viewerSockets());
    retryAt = 0;
    if (statusQueued || viewers.size === 0) {
      return;
    }
    statusQueued = true;
    queueMicrotask(() => {
      statusQueued = false;
      pushStatus().catch(() => undefined);
    });
  };

  return {
    adoptAll,
    close: (socket) => {
      viewers.delete(socket);
    },
    message: (socket, raw) => {
      const viewer = adopt(socket);
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
      retryAt = 0;
      viewer.inputChain = viewer.inputChain.then(() =>
        runInput(viewer, message.actions)
      );
    },
    open: (socket) => {
      const viewer = adopt(socket);
      if (viewer) {
        statusChanged();
      }
    },
    get pumping() {
      return running;
    },
    statusChanged,
    tick,
    get viewerCount() {
      return viewers.size;
    },
  };
};
