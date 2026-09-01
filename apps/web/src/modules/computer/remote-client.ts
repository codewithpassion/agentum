import type { ComputerBackend } from "./client";
import type {
  DirEntry,
  ExecResult,
  ListResult,
  ReadResult,
  WriteResult,
} from "./types";

/**
 * The client half of the `computerd` protocol (docs/plan-computer-backends.md
 * §2): one JSON object per call, the same over Fly's HTTP and over the
 * self-hosted relay's WebSocket, so the two transports differ only in how the
 * bytes travel.
 *
 * Requests are `{ id, op, ... }` and replies are `{ id, result }`, where
 * `result` is one of the types in `types.ts` verbatim - the daemon speaks them,
 * so nothing here translates. Every reply is checked before it is trusted:
 * this is the one place in the app where a result crosses a boundary we do not
 * control, and a malformed one must become a refusal rather than an
 * `undefined` that surfaces three layers up.
 */

/** How the bytes travel. Fly posts them; the relay writes them to a socket. */
export interface Transport {
  send: (message: Record<string, unknown>) => Promise<unknown>;
}

/**
 * A failure whose message is already fit for an agent or a person to read -
 * "the host is offline, start the container". Transports throw it for the
 * conditions they can explain; anything else becomes the generic reason below,
 * because an unhandled error's message is an implementation detail.
 */
export class ComputerTransportError extends Error {}

const UNREACHABLE =
  "The computer could not be reached. It may be offline or still starting - try again in a moment.";

const MALFORMED =
  "The computer sent a reply this server could not understand. Check that its version matches this deployment.";

/** The daemon's own default, and the ceiling a remote backend will accept. */
export const REMOTE_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const REMOTE_EXEC_MAX_TIMEOUT_MS = 600_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `{ id, result }` envelope, unwrapped. A reply whose id is not the one we
 * asked about is discarded rather than used: on a multiplexed socket it means
 * the correlation broke, and answering with another call's result would be
 * worse than failing.
 */
const unwrap = (id: string, reply: unknown): Record<string, unknown> | null => {
  if (!isRecord(reply) || reply.id !== id || !isRecord(reply.result)) {
    return null;
  }
  return reply.result;
};

/**
 * Every result type is a discriminated union on `ok`, so both arms are checked
 * once here: a refusal keeps the daemon's own reason, and anything that is
 * neither arm is malformed rather than optimistically treated as success.
 */
const refusalOf = (
  result: Record<string, unknown>
): { reason: string } | null => {
  if (result.ok === true) {
    return null;
  }
  return {
    reason:
      result.ok === false && typeof result.reason === "string"
        ? result.reason
        : MALFORMED,
  };
};

const asReadResult = (result: Record<string, unknown>): ReadResult => {
  const refusal = refusalOf(result);
  if (refusal) {
    return { ok: false, reason: refusal.reason };
  }
  if (typeof result.content !== "string" || typeof result.size !== "number") {
    return { ok: false, reason: MALFORMED };
  }
  return { content: result.content, ok: true, size: result.size };
};

const asWriteResult = (result: Record<string, unknown>): WriteResult => {
  const refusal = refusalOf(result);
  if (refusal) {
    return { ok: false, reason: refusal.reason };
  }
  if (typeof result.size !== "number") {
    return { ok: false, reason: MALFORMED };
  }
  return { created: result.created === true, ok: true, size: result.size };
};

const asDirEntry = (value: unknown): DirEntry | null => {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }
  return {
    directory: value.directory === true,
    name: value.name,
    size: typeof value.size === "number" ? value.size : 0,
  };
};

const asListResult = (result: Record<string, unknown>): ListResult => {
  const refusal = refusalOf(result);
  if (refusal) {
    return { ok: false, reason: refusal.reason };
  }
  if (!Array.isArray(result.entries)) {
    return { ok: false, reason: MALFORMED };
  }
  const entries: DirEntry[] = [];
  for (const raw of result.entries) {
    const entry = asDirEntry(raw);
    if (!entry) {
      return { ok: false, reason: MALFORMED };
    }
    entries.push(entry);
  }
  return { entries, ok: true };
};

const asExecResult = (result: Record<string, unknown>): ExecResult => {
  const refusal = refusalOf(result);
  if (refusal) {
    return { ok: false, reason: refusal.reason };
  }
  if (typeof result.exitCode !== "number") {
    return { ok: false, reason: MALFORMED };
  }
  return {
    exitCode: result.exitCode,
    ok: true,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
};

/**
 * `btoa` wants a binary string, and spreading a megabyte-long array into
 * `String.fromCharCode` overflows the call stack - hence the chunking. The
 * daemon takes `encoding: "base64"` for exactly this (apps/computerd/README.md).
 */
const BASE64_CHUNK_BYTES = 8192;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...bytes.subarray(at, at + BASE64_CHUNK_BYTES)
    );
  }
  return btoa(binary);
};

type CallOutcome =
  | { failed: true; reason: string }
  | { failed: false; result: Record<string, unknown> };

/**
 * One round trip. A transport that throws is a failure of the connection, not
 * of the operation, so it becomes a refusal a person can act on - never a
 * stack trace, and never an exception the tool layer would have to catch.
 */
const call = async (
  transport: Transport,
  op: string,
  fields: Record<string, unknown>
): Promise<CallOutcome> => {
  const id = crypto.randomUUID();
  let reply: unknown;
  try {
    reply = await transport.send({ id, op, ...fields });
  } catch (error) {
    return {
      failed: true,
      reason:
        error instanceof ComputerTransportError ? error.message : UNREACHABLE,
    };
  }
  const result = unwrap(id, reply);
  return result
    ? { failed: false, result }
    : { failed: true, reason: MALFORMED };
};

/**
 * The five raw operations, over a transport. Path rules, size caps and the
 * activity log are the client's job (`client.ts`) and are applied before any
 * of this runs, exactly as they are for the Durable Object backend.
 */
export const createRemoteBackend = (transport: Transport): ComputerBackend => ({
  async editFile(path, oldString, newString) {
    const result = await call(transport, "edit", {
      newString,
      oldString,
      path,
    });
    return result.failed
      ? { ok: false, reason: result.reason }
      : asWriteResult(result.result);
  },

  async exec(command, timeoutMs) {
    const result = await call(transport, "exec", {
      command,
      timeoutMs: Math.min(
        timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
        REMOTE_EXEC_MAX_TIMEOUT_MS
      ),
    });
    return result.failed
      ? { ok: false, reason: result.reason }
      : asExecResult(result.result);
  },

  async listDir(path) {
    const result = await call(transport, "list", { path });
    return result.failed
      ? { ok: false, reason: result.reason }
      : asListResult(result.result);
  },

  async readFile(path, maxBytes) {
    const result = await call(transport, "read", { maxBytes, path });
    return result.failed
      ? { ok: false, reason: result.reason }
      : asReadResult(result.result);
  },

  async writeFile(path, content) {
    const result = await call(transport, "write", { content, path });
    return result.failed
      ? { ok: false, reason: result.reason }
      : asWriteResult(result.result);
  },

  async writeFileBytes(path, bytes) {
    const result = await call(transport, "write", {
      content: toBase64(bytes),
      encoding: "base64",
      path,
    });
    return result.failed
      ? { ok: false, reason: result.reason }
      : asWriteResult(result.result);
  },
});

export type PingResult =
  | {
      ok: true;
      hostname: string | null;
      uptimeMs: number | null;
      version: string | null;
    }
  | { ok: false; reason: string };

/**
 * "Is anything there?" - what the Test connection button and the host-creation
 * check run. It is the one operation with no file or command behind it, so it
 * is safe to fire at a host whose configuration is still in doubt.
 */
export const ping = async (transport: Transport): Promise<PingResult> => {
  const outcome = await call(transport, "ping", {});
  if (outcome.failed) {
    return { ok: false, reason: outcome.reason };
  }
  const { result } = outcome;
  const refusal = refusalOf(result);
  if (refusal) {
    return { ok: false, reason: refusal.reason };
  }
  return {
    hostname: typeof result.hostname === "string" ? result.hostname : null,
    ok: true,
    uptimeMs: typeof result.uptimeMs === "number" ? result.uptimeMs : null,
    version: typeof result.version === "string" ? result.version : null,
  };
};
