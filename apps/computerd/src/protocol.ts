/**
 * The wire protocol `computerd` speaks: one JSON request object in, one JSON
 * response object out, byte-identical over HTTP (listen mode) and over the
 * WebSocket (connect mode).
 *
 * The result types below mirror `apps/web/src/modules/computer/types.ts`
 * verbatim, so Agentum's remote client does no translation. They are copied
 * rather than imported on purpose: this daemon ships as its own container image
 * and must not depend on the web app.
 *
 * Request paths are absolute *inside* the daemon's root: `/notes/plan.md` means
 * `${COMPUTERD_ROOT}/notes/plan.md`. That is the same namespace the Durable
 * Object backend exposes, so an agent's files look identical whichever backend
 * it runs on.
 */

export interface DirEntry {
  directory: boolean;
  name: string;
  size: number;
}

export type ReadResult =
  | { ok: true; content: string; size: number }
  | { ok: false; reason: string };

export type WriteResult =
  | { ok: true; created: boolean; size: number }
  | { ok: false; reason: string };

export type ListResult =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; reason: string };

export type ExecResult =
  | { ok: true; exitCode: number; stderr: string; stdout: string }
  | { ok: false; reason: string };

/** Liveness plus enough identity for a person to tell two hosts apart. */
export interface PingResult {
  hostname: string;
  ok: true;
  uptimeMs: number;
  version: string;
}

/** How a malformed request, an unknown op or a refused path comes back. */
export interface Failure {
  ok: false;
  reason: string;
}

export type OpResult =
  | ExecResult
  | Failure
  | ListResult
  | PingResult
  | ReadResult
  | WriteResult;

/** Written as utf8 unless the sender says the content is base64. */
export type WriteEncoding = "base64" | "utf8";

/**
 * The requests a sender may make. Nothing parses against these types - the
 * daemon reads fields off an unknown object and answers with a `Failure` when
 * one is missing - but they are the contract Agentum is built against.
 */
export type OpRequest =
  | { id: string; op: "read"; path: string; maxBytes?: number }
  | {
      id: string;
      op: "write";
      path: string;
      content: string;
      encoding?: WriteEncoding;
    }
  | {
      id: string;
      op: "edit";
      path: string;
      oldString: string;
      newString: string;
    }
  | { id: string; op: "list"; path: string }
  | {
      id: string;
      op: "exec";
      command: string;
      timeoutMs?: number;
      cwd?: string;
    }
  | { id: string; op: "ping" };

/** Every reply carries back the request's `id`, so a socket can multiplex. */
export interface OpResponse {
  id: string;
  result: OpResult;
}

/** The first frame connect mode sends, before any request arrives. */
export interface HelloMessage {
  hostname: string;
  type: "hello";
  version: string;
}

/** Sent every 30 s in connect mode; the server answers `heartbeat_ack`. */
export interface HeartbeatMessage {
  type: "heartbeat";
}
