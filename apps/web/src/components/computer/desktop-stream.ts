import type { DesktopAction } from "@repo/protocol/computer";

/**
 * The browser end of the live desktop WebSocket (`src/server/viewer-hub.ts` is
 * the other end). Binary messages are frames: a 4-byte big-endian id, then a
 * JPEG. Text messages are JSON with a `t` tag. This file only speaks the wire;
 * the hook decides what each message means for the view.
 */

const FRAME_HEADER_BYTES = 4;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000] as const;
const NORMAL_CLOSE = 1000;
/** WebSocket.OPEN, kept local because bun's test environment may not define the constant. */
const SOCKET_OPEN = 1;

/** The status of the desktop, as `GET /desktop` and the viewer socket send it. */
export interface DesktopStatus {
  connected: boolean;
  control: {
    expiresAt: number;
    holder: { kind: "agent" } | { kind: "human"; userId: string };
  } | null;
  desktop: boolean;
  desktopUnavailableReason: string | null;
  youHaveControl: boolean;
}

export type StreamMessage =
  | { t: "status"; status: DesktopStatus }
  | { t: "problem"; code: string; message: string }
  | { t: "error"; code: string; message: string };

/** Why the view cannot show a frame. */
export type DesktopProblem =
  | { kind: "human_in_control" }
  | { kind: "clearing" }
  | { kind: "offline" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A text message from the server, or null when it is not one this client knows. */
export function parseStreamMessage(raw: string): StreamMessage | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(body)) {
    return null;
  }
  if (body.t === "status") {
    const { connected, desktop, youHaveControl } = body;
    if (
      typeof connected !== "boolean" ||
      typeof desktop !== "boolean" ||
      typeof youHaveControl !== "boolean"
    ) {
      return null;
    }
    const { control, desktopUnavailableReason } = body;
    return {
      status: {
        connected,
        control: (control ?? null) as DesktopStatus["control"],
        desktop,
        desktopUnavailableReason:
          typeof desktopUnavailableReason === "string"
            ? desktopUnavailableReason
            : null,
        youHaveControl,
      },
      t: "status",
    };
  }
  if (
    (body.t === "problem" || body.t === "error") &&
    typeof body.code === "string"
  ) {
    return {
      code: body.code,
      message: typeof body.message === "string" ? body.message : "",
      t: body.t,
    };
  }
  return null;
}

/** The id and JPEG bytes of a binary message, or null when it is too short to be a frame. */
export function parseFrame(
  data: ArrayBuffer
): { id: number; jpeg: ArrayBuffer } | null {
  if (data.byteLength <= FRAME_HEADER_BYTES) {
    return null;
  }
  return {
    id: new DataView(data).getUint32(0),
    jpeg: data.slice(FRAME_HEADER_BYTES),
  };
}

export const ackMessage = (id: number): string =>
  JSON.stringify({ id, t: "ack" });

export const inputMessage = (actions: readonly DesktopAction[]): string =>
  JSON.stringify({ actions, t: "input" });

/** The view's explanation for a `problem` message; codes are the server's error words. */
export function problemFromCode(code: string, message: string): DesktopProblem {
  switch (code) {
    case "human_in_control":
      return { kind: "human_in_control" };
    case "clearing":
      return { kind: "clearing" };
    case "offline":
      return { kind: "offline" };
    case "desktop_unavailable":
      return { kind: "unavailable", message };
    default:
      return { kind: "failed", message };
  }
}

/** The stream's address on this origin: wss on an https page, ws otherwise. */
export function streamUrl({
  host,
  pathname,
  protocol,
}: {
  host: string;
  pathname: string;
  protocol: string;
}): string {
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${pathname}`;
}

export const desktopStreamPath = (machineId: string): string =>
  `/api/machines/${encodeURIComponent(machineId)}/desktop/stream`;

export interface DesktopStreamHandlers {
  onClosed: (wasOpen: boolean) => void;
  onFrame: (jpeg: Blob) => void;
  onInputError: (code: string, message: string) => void;
  onOpen: () => void;
  onProblem: (problem: DesktopProblem) => void;
  onStatus: (status: DesktopStatus) => void;
}

export interface DesktopStream {
  close: () => void;
  isOpen: () => boolean;
  /** False when the socket is not open and nothing was sent. */
  sendInput: (actions: readonly DesktopAction[]) => boolean;
}

export interface OpenStreamOptions {
  createSocket?: (url: string) => WebSocket;
  handlers: DesktopStreamHandlers;
  /** Frames are not acked while this is true, so a hidden tab stops being sent them. */
  isHidden?: () => boolean;
  /** Runs `run` after `ms`, and returns a function that cancels it. */
  schedule?: (run: () => void, ms: number) => () => void;
  url: string;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Opens the stream and keeps it open: frames are acked as they arrive (not while
 * the tab is hidden), and a socket that closes is reopened with capped backoff,
 * for as long as the stream is not closed.
 */
export function openDesktopStream({
  createSocket = (address) => new WebSocket(address),
  handlers,
  isHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  schedule = defaultSchedule,
  url,
}: OpenStreamOptions): DesktopStream {
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnects = 0;
  let cancelReconnect: (() => void) | null = null;
  let lastFrameId: number | null = null;
  let ackedFrameId: number | null = null;

  const sendAck = () => {
    if (
      socket?.readyState !== SOCKET_OPEN ||
      lastFrameId === null ||
      lastFrameId === ackedFrameId
    ) {
      return;
    }
    ackedFrameId = lastFrameId;
    socket.send(ackMessage(lastFrameId));
  };

  const onVisibility = () => {
    if (!isHidden()) {
      sendAck();
    }
  };

  const handleMessage = (data: unknown) => {
    if (data instanceof ArrayBuffer) {
      const frame = parseFrame(data);
      if (frame) {
        lastFrameId = frame.id;
        handlers.onFrame(new Blob([frame.jpeg], { type: "image/jpeg" }));
        if (!isHidden()) {
          sendAck();
        }
      }
      return;
    }
    if (typeof data !== "string") {
      return;
    }
    const message = parseStreamMessage(data);
    if (message?.t === "status") {
      handlers.onStatus(message.status);
    } else if (message?.t === "problem") {
      handlers.onProblem(problemFromCode(message.code, message.message));
    } else if (message?.t === "error") {
      handlers.onInputError(message.code, message.message);
    }
  };

  const connect = () => {
    cancelReconnect = null;
    const opened = createSocket(url);
    opened.binaryType = "arraybuffer";
    socket = opened;
    let didOpen = false;
    opened.addEventListener("open", () => {
      didOpen = true;
      reconnects = 0;
      lastFrameId = null;
      ackedFrameId = null;
      handlers.onOpen();
    });
    opened.addEventListener("message", (event) => {
      if (socket === opened) {
        handleMessage(event.data);
      }
    });
    opened.addEventListener("close", () => {
      if (stopped || socket !== opened) {
        return;
      }
      socket = null;
      handlers.onClosed(didOpen);
      const delay =
        RECONNECT_DELAYS_MS.at(
          Math.min(reconnects, RECONNECT_DELAYS_MS.length - 1)
        ) ?? 0;
      reconnects += 1;
      cancelReconnect = schedule(connect, delay);
    });
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  connect();

  return {
    close: () => {
      stopped = true;
      cancelReconnect?.();
      cancelReconnect = null;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      const closing = socket;
      socket = null;
      closing?.close(NORMAL_CLOSE);
    },
    isOpen: () => socket?.readyState === SOCKET_OPEN,
    sendInput: (actions) => {
      if (socket?.readyState !== SOCKET_OPEN) {
        return false;
      }
      socket.send(inputMessage(actions));
      return true;
    },
  };
}
