import { ApiError, type Question } from "#/lib/api";
import type { DesktopAction } from "#/lib/desktop-input";
import {
  type DesktopStream,
  type DesktopStreamHandlers,
  openDesktopStream,
  streamUrl,
} from "#/lib/desktop-stream";

/**
 * The client side of an agent's live desktop. Routes are agent-scoped, so the
 * only identity a call needs is the agent. The status and failure shapes are
 * the ones the desktop view reads; they are built here from the wire.
 */

export type DesktopController =
  | { kind: "none" }
  | { kind: "agent" }
  | { kind: "human"; isMe: boolean; expiresAt: string };

/** A takeover the agent is waiting on: a person was asked to use the desktop. */
export interface PendingTakeover {
  createdAt: number;
  id: string;
  reason: string;
}

export interface DesktopStatus {
  controller: DesktopController;
  /** Whether the computer reports a running desktop. */
  desktop: boolean;
  /** Why the computer has no desktop, when it says why. */
  desktopUnavailableReason: string | null;
  online: boolean;
  /** The takeover the agent is waiting on, or null. */
  pendingTakeover: PendingTakeover | null;
}

/** What the status route sends; `youHaveControl` says whether the caller is the holder. */
export interface WireDesktopStatus {
  connected: boolean;
  control: {
    holder: { kind: "agent" | "human"; userId?: string; agentId?: string };
    /** Epoch milliseconds, as the relay sends it. */
    expiresAt: number;
  } | null;
  desktop: boolean;
  desktopUnavailableReason: string | null;
  pendingTakeover?: PendingTakeover | null;
  youHaveControl: boolean;
}

const controllerOf = (wire: WireDesktopStatus): DesktopController => {
  const { control } = wire;
  if (control === null) {
    return { kind: "none" };
  }
  if (control.holder.kind === "agent") {
    return { kind: "agent" };
  }
  return {
    expiresAt: new Date(control.expiresAt).toISOString(),
    isMe: wire.youHaveControl,
    kind: "human",
  };
};

export const toDesktopStatus = (wire: WireDesktopStatus): DesktopStatus => ({
  controller: controllerOf(wire),
  desktop: wire.desktop,
  desktopUnavailableReason: wire.desktopUnavailableReason,
  online: wire.connected,
  pendingTakeover: wire.pendingTakeover ?? null,
});

export interface DesktopRequestFailure {
  code: string | null;
  message: string;
  statusCode: number;
}

/** A refused desktop call. `status` is the HTTP status; `code` is the server's `error` word. */
export class DesktopApiError extends ApiError {
  readonly code: string | null;

  constructor(statusCode: number, code: string | null) {
    super(describeFailure({ code, statusCode }), statusCode);
    this.name = "DesktopApiError";
    this.code = code;
  }
}

const FAILURE_TEXT: Record<string, string> = {
  already_handled: "This takeover was already handled.",
  clearing:
    "The last person's clipboard is being cleared. Try again in a moment.",
  desktop_failed: "The desktop did not answer. Try again.",
  desktop_unavailable: "This computer has no desktop.",
  human_in_control: "Another person is in control of this desktop.",
  lease_required: "Take control before you use the desktop.",
  offline: "The computer is offline.",
};

const describeFailure = ({
  code,
  statusCode,
}: {
  code: string | null;
  statusCode: number;
}): string => {
  const known = code === null ? undefined : FAILURE_TEXT[code];
  return known ?? `Request failed (${String(statusCode)}).`;
};

/** The refusal a desktop call rejected with, or null for anything else (network, abort, bug). */
export function readDesktopFailure(
  error: unknown
): DesktopRequestFailure | null {
  if (!(error instanceof DesktopApiError)) {
    return null;
  }
  return { code: error.code, message: error.message, statusCode: error.status };
}

/** Why the live frame is not showing, as the view explains it. */
export type DesktopFrameProblem =
  | { kind: "human_in_control" }
  | { kind: "clearing" }
  | { kind: "offline" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

export function toFrameProblem(error: unknown): DesktopFrameProblem {
  const failure = readDesktopFailure(error);
  if (failure === null) {
    return {
      kind: "failed",
      message:
        error instanceof Error
          ? error.message
          : "The frame could not be loaded",
    };
  }
  if (failure.statusCode === 423) {
    return { kind: "human_in_control" };
  }
  if (failure.statusCode === 409 && failure.code === "clearing") {
    return { kind: "clearing" };
  }
  if (failure.statusCode === 503 && failure.code === "offline") {
    return { kind: "offline" };
  }
  if (failure.statusCode === 503) {
    return { kind: "unavailable", message: failure.message };
  }
  return { kind: "failed", message: failure.message };
}

export interface DesktopRequest {
  agentId: string;
}

/**
 * The server port the desktop view drives. `computerId` may ride along in a request
 * object (the view keys its state by it), but routes only need the agent.
 */
export interface ComputerDesktopServer {
  /** Declines a takeover request; answers with the settled question. */
  cancelTakeover: (req: DesktopRequest) => Promise<Question>;
  getDesktopClipboard: (req: DesktopRequest) => Promise<{ text: string }>;
  getDesktopScreenshot: (
    req: DesktopRequest & { signal?: AbortSignal }
  ) => Promise<Blob>;
  getDesktopStatus: (req: DesktopRequest) => Promise<DesktopStatus>;
  handBackDesktop: (
    req: DesktopRequest & { note?: string }
  ) => Promise<DesktopStatus>;
  /**
   * Opens the live WebSocket stream. Absent where there is no socket to open, and
   * the view then polls over HTTP; it also polls when the socket cannot be opened.
   */
  openDesktopStream?: (
    req: DesktopRequest,
    handlers: DesktopStreamHandlers
  ) => DesktopStream;
  /** Needs control; answers with a fresh frame. */
  sendDesktopInput: (
    req: DesktopRequest & { actions: DesktopAction[] }
  ) => Promise<Blob>;
  setDesktopClipboard: (
    req: DesktopRequest & { text: string }
  ) => Promise<void>;
  takeDesktopControl: (req: DesktopRequest) => Promise<DesktopStatus>;
}

/** The workspace-scoped base every route hangs from, as `createApi` builds it. */
export const desktopUrl = (
  workspaceSlug: string,
  agentId: string,
  path = ""
): string =>
  `/api/w/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(agentId)}/desktop${path}`;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const failureOf = async (response: Response): Promise<DesktopApiError> => {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  const code = typeof body?.error === "string" ? body.error : null;
  return new DesktopApiError(response.status, code);
};

const send = async (
  fetcher: Fetcher,
  url: string,
  init: { body?: unknown; method?: string; signal?: AbortSignal } = {}
): Promise<Response> => {
  const { body, method = "GET", signal } = init;
  const response = await fetcher(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    method,
    signal,
  });
  if (!response.ok) {
    throw await failureOf(response);
  }
  return response;
};

/** Talks to one workspace's desktop routes. `fetcher` defaults to the global fetch, read at call time. */
export const createDesktopServer = (
  workspaceSlug: string,
  fetcher: Fetcher = (url, init) => fetch(url, init)
): ComputerDesktopServer => {
  const at = (agentId: string, path = "") =>
    desktopUrl(workspaceSlug, agentId, path);

  const statusOf = async (response: Response): Promise<DesktopStatus> =>
    toDesktopStatus((await response.json()) as WireDesktopStatus);

  return {
    cancelTakeover: async ({ agentId }) => {
      const response = await send(fetcher, at(agentId, "/cancel-takeover"), {
        method: "POST",
      });
      const body = (await response.json()) as { question: Question };
      return body.question;
    },

    getDesktopClipboard: async ({ agentId }) =>
      (await send(fetcher, at(agentId, "/clipboard"))).json() as Promise<{
        text: string;
      }>,

    getDesktopScreenshot: async ({ agentId, signal }) =>
      (await send(fetcher, at(agentId, "/screenshot"), { signal })).blob(),

    getDesktopStatus: async ({ agentId }) =>
      statusOf(await send(fetcher, at(agentId))),

    handBackDesktop: async ({ agentId, note }) =>
      statusOf(
        await send(fetcher, at(agentId, "/hand-back"), {
          body: note === undefined ? {} : { note },
          method: "POST",
        })
      ),

    openDesktopStream: ({ agentId }, handlers) =>
      openDesktopStream({
        handlers,
        url: streamUrl({
          host: location.host,
          pathname: at(agentId, "/stream"),
          protocol: location.protocol,
        }),
      }),

    sendDesktopInput: async ({ actions, agentId }) =>
      (
        await send(fetcher, at(agentId, "/input"), {
          body: { actions },
          method: "POST",
        })
      ).blob(),

    setDesktopClipboard: async ({ agentId, text }) => {
      await send(fetcher, at(agentId, "/clipboard"), {
        body: { text },
        method: "PUT",
      });
    },

    takeDesktopControl: async ({ agentId }) =>
      statusOf(
        await send(fetcher, at(agentId, "/take-control"), { method: "POST" })
      ),
  };
};
