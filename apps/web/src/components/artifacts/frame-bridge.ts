// The frame side of the artifact bridge (R1.20, R1.21). No DOM and no React in
// here, so bun tests can drive it with fake events.
//
// The iframe is sandboxed without `allow-same-origin`, so its origin is
// opaque: messages from it carry `origin: "null"` and replies must target
// "*". The only trust anchor is `event.source`, compared with the iframe's
// `contentWindow`. The first `ui/initialize` from that window gets a reply with
// one transferred MessagePort. Everything after that goes through the port.
// Navigating the iframe kills the port with its document, so the frame can
// never post data to a page that replaced the artifact.

import {
  type BridgeMessage,
  type JsonRpcErrorResponse,
  parseBridgeMessage,
  type UiInitializeResult,
} from "@repo/protocol/artifacts";

/** JSON-RPC error codes the frame answers with. */
export const BRIDGE_ERROR = {
  denied: -32_000,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
} as const;

/** How long after an iframe `load` a fresh `ui/initialize` may still arrive. */
export const INITIALIZE_GRACE_MS = 2000;

/**
 * The page retries `ui/initialize` every 250 ms until it gets the reply, so
 * repeats can already be in flight when the reply goes out. For this long
 * after an accepted initialize, further ones are ignored.
 */
export const INITIALIZE_REPEAT_WINDOW_MS = 1000;

export type BridgeMethod = BridgeMessage["method"];

type RequestOf<M extends BridgeMethod> = Extract<BridgeMessage, { method: M }>;

/**
 * What a handler may return. A request handler returns the `result` object.
 * A thrown `BridgeError` becomes a JSON-RPC error response.
 */
export class BridgeError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** One entry per method. Phase 2 adds `tools/call`, `storage/*` and `ui/message`. */
export type BridgeHandlers = {
  [M in BridgeMethod]?: (message: RequestOf<M>) => unknown;
};

/** The slice of a MessagePort the bridge uses. */
export interface BridgePort {
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

/** The slice of a Window the bridge posts to. */
export interface BridgeTarget {
  postMessage: (
    message: unknown,
    targetOrigin: string,
    transfer: Transferable[]
  ) => void;
}

/** The slice of a `message` event the bridge reads. */
export interface BridgeWindowEvent {
  data: unknown;
  source: unknown;
}

export interface FrameBridgeOptions {
  clearTimer?: (handle: unknown) => void;
  /** Resolves true when the viewer agrees to open the link in a new tab. */
  confirmOpenLink: (url: string) => boolean | Promise<boolean>;
  /** Makes the channel. Defaults to the global `MessageChannel`. */
  createChannel?: () => { port1: BridgePort; port2: unknown };
  /** Handlers added to the table, for phase 2. They run after validation. */
  extraHandlers?: BridgeHandlers;
  /** What `ui/initialize` answers with. */
  getInit: () => UiInitializeResult;
  /** The iframe's `contentWindow`, read on every message. */
  getTarget: () => (BridgeTarget & object) | null;
  graceMs?: number;
  /** Clock in ms, for the repeat window. Defaults to `Date.now`. */
  now?: () => number;
  /** Called when the iframe left its page without a fresh `ui/initialize`. */
  onBlank: () => void;
  /** Called when the page reports a size. */
  onSizeChanged?: (size: { height?: number; width?: number }) => void;
  /** Opens the link in a new tab. */
  openLink: (url: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export interface FrameBridge {
  /** Stops listening and closes the port. */
  dispose: () => void;
  /** Wire this to the iframe's `load` event. */
  handleLoad: () => void;
  /** Wire this to `window.addEventListener("message", ...)`. */
  handleWindowMessage: (event: BridgeWindowEvent) => void;
}

const errorResponse = (
  id: string | number | null,
  code: number,
  message: string
): JsonRpcErrorResponse => ({
  error: { code, message },
  id,
  jsonrpc: "2.0",
});

const requestId = (value: unknown): string | number | null => {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return null;
  }
  const { id } = value;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

export function createFrameBridge(options: FrameBridgeOptions): FrameBridge {
  const {
    onBlank,
    onSizeChanged,
    confirmOpenLink,
    openLink,
    getInit,
    getTarget,
    extraHandlers,
  } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const createChannel =
    options.createChannel ??
    (() => {
      const channel = new MessageChannel();
      return { port1: channel.port1, port2: channel.port2 };
    });
  const graceMs = options.graceMs ?? INITIALIZE_GRACE_MS;
  const now = options.now ?? Date.now;

  let port: BridgePort | null = null;
  let blanked = false;
  let disposed = false;
  // Initializes seen since the last `load`. An initialize may land just before
  // or just after its document's `load`, so `load` checks this and, when it is
  // zero, waits out a grace period before it blanks.
  let initializesSinceLoad = 0;
  let timer: unknown = null;
  // A second initialize is a repeat unless the iframe has loaded a document
  // since the accepted one and the repeat window is over.
  let acceptedAt = Number.NEGATIVE_INFINITY;
  let loadedSinceAccept = true;
  let linkPending = false;

  const stopTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const closePort = () => {
    if (port) {
      port.onmessage = null;
      port.close();
      port = null;
    }
  };

  const blank = () => {
    if (blanked || disposed) {
      return;
    }
    blanked = true;
    closePort();
    onBlank();
  };

  const handlers: BridgeHandlers = {
    "ui/notifications/initialized": () => undefined,
    "ui/notifications/size-changed": (message) => {
      onSizeChanged?.(message.params);
    },
    "ui/open-link": async (message) => {
      // One prompt at a time, so a page can't stack dialogs.
      if (linkPending) {
        throw new BridgeError(BRIDGE_ERROR.denied, "Another link is pending");
      }
      linkPending = true;
      try {
        const agreed = await confirmOpenLink(message.params.url);
        if (!agreed || blanked || disposed) {
          throw new BridgeError(BRIDGE_ERROR.denied, "The viewer said no");
        }
        openLink(message.params.url);
        return {};
      } finally {
        linkPending = false;
      }
    },
    ...extraHandlers,
  };

  const reply = (current: BridgePort, message: unknown) => {
    // A reply that arrives after the port was replaced goes nowhere.
    if (port === current) {
      current.postMessage(message);
    }
  };

  const respondError = (
    current: BridgePort,
    message: BridgeMessage,
    code: number,
    text: string
  ) => {
    if ("id" in message) {
      reply(current, errorResponse(message.id, code, text));
    }
  };

  const runHandler = async (current: BridgePort, message: BridgeMessage) => {
    const handler = handlers[message.method] as
      | ((m: BridgeMessage) => unknown)
      | undefined;
    if (!handler) {
      respondError(
        current,
        message,
        BRIDGE_ERROR.methodNotFound,
        `Method not found: ${message.method}`
      );
      return;
    }
    try {
      const result = await handler(message);
      if ("id" in message) {
        reply(current, {
          id: message.id,
          jsonrpc: "2.0",
          result: result ?? {},
        });
      }
    } catch (error) {
      const code =
        error instanceof BridgeError ? error.code : BRIDGE_ERROR.denied;
      const text = error instanceof Error ? error.message : "Request failed";
      respondError(current, message, code, text);
    }
  };

  const dispatch = (current: BridgePort, data: unknown) => {
    const message = parseBridgeMessage(data);
    if (!message) {
      const id = requestId(data);
      if (id !== null) {
        reply(
          current,
          errorResponse(id, BRIDGE_ERROR.invalidRequest, "Invalid request")
        );
      }
      return;
    }
    if (message.method === "ui/initialize") {
      // A page repeating itself on a live port. A new document gets its
      // port from a window message, never over this one.
      reply(
        current,
        errorResponse(
          message.id,
          BRIDGE_ERROR.invalidRequest,
          "Already initialized"
        )
      );
      return;
    }
    runHandler(current, message);
  };

  return {
    dispose: () => {
      disposed = true;
      stopTimer();
      closePort();
    },
    handleLoad: () => {
      if (blanked || disposed) {
        return;
      }
      loadedSinceAccept = true;
      // The port stays: an initialize that came just before this `load` belongs
      // to this document. A navigation kills the old port by itself.
      if (initializesSinceLoad > 0) {
        initializesSinceLoad = 0;
        stopTimer();
        return;
      }
      stopTimer();
      timer = setTimer(() => {
        timer = null;
        if (initializesSinceLoad === 0) {
          blank();
        }
      }, graceMs);
    },
    handleWindowMessage: (event) => {
      if (blanked || disposed) {
        return;
      }
      const target = getTarget();
      if (!target || event.source !== target) {
        return;
      }
      const message = parseBridgeMessage(event.data);
      if (message?.method !== "ui/initialize" || !("id" in message)) {
        return;
      }
      const isRepeat =
        port !== null &&
        (!loadedSinceAccept ||
          now() - acceptedAt < INITIALIZE_REPEAT_WINDOW_MS);
      if (isRepeat) {
        return;
      }
      acceptedAt = now();
      loadedSinceAccept = false;
      initializesSinceLoad += 1;
      stopTimer();
      closePort();
      const channel = createChannel();
      const next = channel.port1;
      port = next;
      next.onmessage = (portEvent) => {
        dispatch(next, portEvent.data);
      };
      target.postMessage(
        { id: message.id, jsonrpc: "2.0", result: getInit() },
        "*",
        [channel.port2 as Transferable]
      );
    },
  };
}
