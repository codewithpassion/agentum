import type {
  ComputerCapabilities,
  DesktopClipboardSetRequest,
  DesktopInputRequest,
  DesktopScreenshotRequest,
  ExecRequest,
  FileGetRequest,
  FilePutRequest,
} from "@repo/protocol/computer";

/**
 * Who a computer request acts for. An agent with no `agentId` matches any
 * agent, because one computer serves one agent. The Worker sets it from the
 * run or the signed-in user, never from anything a client sent, because the
 * desktop lease is decided on it.
 */
export type ComputerPrincipal =
  | { kind: "agent"; agentId?: string }
  | { kind: "human"; userId: string };

/** Why a request got no answer from the computer. A client's own error is `client_error`, with its `code`. */
export type ComputerFailureReason =
  | "client_error"
  | "desktop_busy"
  | "desktop_unavailable"
  | "duplicate_id"
  | "forbidden"
  | "human_in_control"
  | "interrupted"
  | "offline"
  | "queue_full"
  | "replaced"
  | "revoked"
  | "stale"
  | "timeout";

/**
 * What a computer request resolves to. Never thrown across RPC. `resultJson` is
 * the reply's `result` for the caller to read with the op's `parse*Result`
 * function in `@repo/protocol/computer`. `code` is the computer's own error code
 * (`not_found`, `read_only`, ...) and is set only for `client_error`.
 */
export type ComputerOutcome =
  | { ok: true; resultJson: string }
  | {
      code: string | null;
      message: string;
      ok: false;
      reason: ComputerFailureReason;
    };

/** Who holds the desktop, and until when. `expiresAt` is epoch milliseconds. */
export interface ComputerControl {
  expiresAt: number;
  holder: ComputerPrincipal;
}

export type TakeHumanLeaseOutcome =
  | { control: ComputerControl; ok: true }
  | {
      message: string;
      ok: false;
      reason: "desktop_busy" | "desktop_unavailable";
    };

/** The computer role's connection as the relay sees it. Times are epoch milliseconds. */
export interface ComputerStatus {
  capabilities: ComputerCapabilities | null;
  connected: boolean;
  /** Null when nobody holds the desktop, and while it is being cleared. */
  control: ComputerControl | null;
  hostname: string | null;
  inFlightExec: number;
  lastSeenAt: number | null;
  queued: number;
  version: string | null;
  workdir: string | null;
}

/** What the machines service and the machine runtime adapter ask of the relay. */
export interface MachineRelayPort {
  /**
   * Tells the daemon that library paths changed. Does nothing when no socket
   * is open or the daemon did not name `library-live`.
   */
  announce: (machineId: string, paths: string[]) => Promise<void>;
  /** Tells the daemon to stop a run. Does nothing when no socket is open. */
  cancel: (machineId: string, runId: string) => Promise<void>;

  // The computer role. Each call is one op on the machine's computer socket.
  clipboardGet: (
    machineId: string,
    principal: ComputerPrincipal
  ) => Promise<ComputerOutcome>;
  clipboardSet: (
    machineId: string,
    principal: ComputerPrincipal,
    input: Omit<DesktopClipboardSetRequest, "op">
  ) => Promise<ComputerOutcome>;
  computerExec: (
    machineId: string,
    principal: ComputerPrincipal,
    input: Omit<ExecRequest, "op">
  ) => Promise<ComputerOutcome>;
  computerStatus: (machineId: string) => Promise<ComputerStatus>;
  desktopInput: (
    machineId: string,
    principal: ComputerPrincipal,
    input: Omit<DesktopInputRequest, "op">
  ) => Promise<ComputerOutcome>;
  desktopScreenshot: (
    machineId: string,
    principal: ComputerPrincipal,
    input: Omit<DesktopScreenshotRequest, "op">
  ) => Promise<ComputerOutcome>;
  fileGet: (
    machineId: string,
    principal: ComputerPrincipal,
    input: Omit<FileGetRequest, "op">
  ) => Promise<ComputerOutcome>;
  filePut: (
    machineId: string,
    principal: ComputerPrincipal,
    input: Omit<FilePutRequest, "op">
  ) => Promise<ComputerOutcome>;
  /** Offers a run to the daemon. Does nothing when no socket is open. */
  offer: (
    machineId: string,
    offer: { agentId: string; runId: string; subagent?: boolean }
  ) => Promise<void>;
  /** A person hands the desktop back. It is free once the clipboard is cleared. */
  releaseHumanLease: (
    machineId: string,
    userId: string
  ) => Promise<{ clipboardCleared: boolean; released: boolean }>;
  /** Closes every open socket of the machine with 4401. */
  revoke: (machineId: string) => Promise<void>;
  /** A person takes the desktop, preempting any agent at once. */
  takeHumanLease: (
    machineId: string,
    userId: string
  ) => Promise<TakeHumanLeaseOutcome>;
}

const offlineOutcome: ComputerOutcome = {
  code: null,
  message: "No computer is connected.",
  ok: false,
  reason: "offline",
};

/** A relay with no daemon or computer behind it: scripts and tests that only need the port filled. */
export const noopRelay: MachineRelayPort = {
  announce: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
  clipboardGet: () => Promise.resolve(offlineOutcome),
  clipboardSet: () => Promise.resolve(offlineOutcome),
  computerExec: () => Promise.resolve(offlineOutcome),
  computerStatus: () =>
    Promise.resolve({
      capabilities: null,
      connected: false,
      control: null,
      hostname: null,
      inFlightExec: 0,
      lastSeenAt: null,
      queued: 0,
      version: null,
      workdir: null,
    }),
  desktopInput: () => Promise.resolve(offlineOutcome),
  desktopScreenshot: () => Promise.resolve(offlineOutcome),
  fileGet: () => Promise.resolve(offlineOutcome),
  filePut: () => Promise.resolve(offlineOutcome),
  offer: () => Promise.resolve(),
  releaseHumanLease: () =>
    Promise.resolve({ clipboardCleared: false, released: false }),
  revoke: () => Promise.resolve(),
  takeHumanLease: () =>
    Promise.resolve({
      message: "No computer is connected.",
      ok: false,
      reason: "desktop_unavailable",
    }),
};
