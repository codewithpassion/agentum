import type { DesktopFrameProblem, WireDesktopStatus } from "#/lib/desktop-api";
import type { DesktopAction } from "#/lib/desktop-input";

/**
 * The browser end of the live desktop WebSocket (`modules/computer/viewer-hub.ts`
 * is the other end). Binary messages are frames: a 4-byte big-endian id, then a
 * JPEG. Text messages are JSON with a `t` tag. This file only speaks the wire;
 * the hook decides what each message means for the view.
 */

const FRAME_HEADER_BYTES = 4;
/** A socket that fails to open this many times in a row is given up on, so polling takes over. */
export const MAX_OPEN_FAILURES = 2;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000] as const;
const NORMAL_CLOSE = 1000;

export type StreamMessage =
  | { t: "status"; status: WireDesktopStatus }
  | { t: "problem"; code: string; message: string }
  | { t: "error"; code: string; message: string };

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
  if (body.t === "status" && typeof body.connected === "boolean") {
    const { t: _tag, ...status } = body;
    return { status: status as unknown as WireDesktopStatus, t: "status" };
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

/** The view's explanation for a `problem` message; codes are the HTTP routes' error words. */
export function problemFromCode(
  code: string,
  message: string
): DesktopFrameProblem {
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

export interface DesktopStreamHandlers {
  onFrame: (jpeg: Blob) => void;
  onInputError: (code: string, message: string) => void;
  /** The socket was open and dropped; it is being reopened. */
  onInterrupted: () => void;
  /** The socket opened. */
  onOpen: () => void;
  onProblem: (problem: DesktopFrameProblem) => void;
  onStatus: (status: WireDesktopStatus) => void;
  /** The socket could not be opened after repeated tries: the caller should poll over HTTP. */
  onUnavailable: () => void;
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
  url: string;
}

/**
 * Opens the stream and keeps it open: frames are acked as they arrive (not while
 * the tab is hidden), a dropped socket is reopened with backoff, and a socket
 * that never opens hands the view back to HTTP polling.
 */
export function openDesktopStream({
  createSocket = (address) => new WebSocket(address),
  handlers,
  isHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  url,
}: OpenStreamOptions): DesktopStream {
  let socket: WebSocket | null = null;
  let stopped = false;
  let everOpened = false;
  let failures = 0;
  let reconnects = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFrameId: number | null = null;
  let ackedFrameId: number | null = null;

  const sendAck = () => {
    if (
      socket?.readyState !== WebSocket.OPEN ||
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
    timer = null;
    const opened = createSocket(url);
    opened.binaryType = "arraybuffer";
    socket = opened;
    let didOpen = false;
    opened.addEventListener("open", () => {
      didOpen = true;
      everOpened = true;
      failures = 0;
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
      if (didOpen) {
        handlers.onInterrupted();
      } else {
        failures += 1;
        if (failures >= MAX_OPEN_FAILURES) {
          stopped = true;
          handlers.onUnavailable();
          return;
        }
      }
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(reconnects, RECONNECT_DELAYS_MS.length - 1)
        ];
      reconnects += 1;
      timer = setTimeout(connect, delay);
    });
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  connect();

  return {
    close: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      const closing = socket;
      socket = null;
      closing?.close(NORMAL_CLOSE);
    },
    isOpen: () => everOpened && socket?.readyState === WebSocket.OPEN,
    sendInput: (actions) => {
      if (socket?.readyState !== WebSocket.OPEN) {
        return false;
      }
      socket.send(inputMessage(actions));
      return true;
    },
  };
}
