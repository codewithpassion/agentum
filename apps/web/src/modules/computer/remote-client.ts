import type { ComputerBackend } from "./client";
import { MAX_FILE_BYTES } from "./paths";
import { FILE_CHUNK_BYTES } from "./protocol";
import type {
  DirEntry,
  ExecResult,
  ListResult,
  ReadResult,
  WriteResult,
} from "./types";

/**
 * The client half of the v1 computer protocol (docs/remote-computers-protocol.md).
 * One JSON object per call, `{ id, op, ... }`, answered by `{ id, result }` or
 * `{ id, error: { code, message } }`. The daemon speaks only `exec`, `cancel`,
 * `file_put` and `file_get` here, so every file operation the tools need is
 * built from those four.
 *
 * Paths the tools pass are relative to the agent's directory on the host. The
 * directory is resolved once per call through `SessionRoot`, because the daemon
 * only accepts absolute paths and the root depends on the host's working
 * directory, which only the host knows.
 */

/** How the bytes travel. The self-hosted relay writes them to a socket. */
export interface Transport {
  send: (message: Record<string, unknown>) => Promise<unknown>;
}

/**
 * A failure whose message is already fit for an agent or a person to read.
 * Transports throw it for the conditions they can explain. `timedOut` tells the
 * caller a command may still be running, so it can cancel it.
 */
export class ComputerTransportError extends Error {
  readonly timedOut: boolean;

  constructor(
    message: string,
    options?: { cause?: unknown; timedOut?: boolean }
  ) {
    super(message, { cause: options?.cause });
    this.timedOut = options?.timedOut === true;
  }
}

/** The directory this agent's files live in on the host, or why there is none. */
export type SessionRoot = () => Promise<
  { ok: true; path: string } | { ok: false; reason: string }
>;

const UNREACHABLE =
  "The computer could not be reached. It may be offline or still starting - try again in a moment.";

const MALFORMED =
  "The computer sent a reply this server could not understand. Check that its version matches this deployment.";

/** The daemon's own default, and the ceiling a remote backend will accept. */
export const REMOTE_EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const REMOTE_EXEC_MAX_TIMEOUT_MS = 600_000;

const PING_TIMEOUT_MS = 10_000;

const TIMED_OUT_CANCELLED_NOTE =
  "The command did not finish in time and was cancelled on the computer.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type CallOutcome =
  | { failed: false; result: Record<string, unknown> }
  | {
      failed: true;
      reason: string;
      /** The daemon's own error code, when it answered with one. */
      code: string | null;
      timedOut: boolean;
    };

const failure = (
  reason: string,
  extra: { code?: string | null; timedOut?: boolean } = {}
): CallOutcome => ({
  code: extra.code ?? null,
  failed: true,
  reason,
  timedOut: extra.timedOut ?? false,
});

/**
 * One round trip. A reply for another id is discarded rather than used: on a
 * multiplexed socket it means the correlation broke. An `error` reply keeps the
 * daemon's own code and message.
 */
const call = async (
  transport: Transport,
  op: string,
  fields: Record<string, unknown>,
  id: string = crypto.randomUUID()
): Promise<CallOutcome> => {
  let reply: unknown;
  try {
    reply = await transport.send({ id, op, ...fields });
  } catch (error) {
    if (error instanceof ComputerTransportError) {
      return failure(error.message, { timedOut: error.timedOut });
    }
    return failure(UNREACHABLE);
  }
  if (!isRecord(reply) || reply.id !== id) {
    return failure(MALFORMED);
  }
  if (isRecord(reply.error)) {
    const { code, message } = reply.error;
    return failure(typeof message === "string" ? message : MALFORMED, {
      code: typeof code === "string" ? code : null,
    });
  }
  if (!isRecord(reply.result)) {
    return failure(MALFORMED);
  }
  return { failed: false, result: reply.result };
};

/** `btoa` wants a binary string, and spreading a large array overflows the call stack. */
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

const fromBase64 = (encoded: string): Uint8Array =>
  Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Single-quotes a value for `sh -c`, so no path or name can change the command. */
const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

const execCommand = async (
  transport: Transport,
  cwd: string | null,
  command: string,
  timeoutMs: number | undefined
): Promise<ExecResult> => {
  const timeout = Math.min(
    timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
    REMOTE_EXEC_MAX_TIMEOUT_MS
  );
  const id = crypto.randomUUID();
  const outcome = await call(
    transport,
    "exec",
    { command, cwd, env: {}, timeout_ms: timeout },
    id
  );
  if (outcome.failed) {
    if (outcome.timedOut) {
      // The relay gave up, but the command may still be running on the machine.
      await call(transport, "cancel", { target_id: id });
      return {
        ok: false,
        reason: `${outcome.reason} ${TIMED_OUT_CANCELLED_NOTE}`,
      };
    }
    return { ok: false, reason: outcome.reason };
  }
  const { result } = outcome;
  if (typeof result.exit_code !== "number") {
    return { ok: false, reason: MALFORMED };
  }
  return {
    exitCode: result.exit_code,
    ok: true,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
};

/** Reads one chunk; `file_get` is the only read the daemon offers. */
const readChunk = async (
  transport: Transport,
  path: string,
  offset: number,
  maxBytes: number
): Promise<CallOutcome> =>
  call(transport, "file_get", { max_bytes: maxBytes, offset, path });

/** Whether a path is absent, judged by the daemon's own `not_found` answer. */
const isMissing = async (
  transport: Transport,
  path: string
): Promise<boolean> => {
  const outcome = await readChunk(transport, path, 0, 1);
  return outcome.failed && outcome.code === "not_found";
};

/** Writes bytes in `FILE_CHUNK_BYTES` pieces, sharing one transfer id and a whole-file digest. */
const putBytes = async (
  transport: Transport,
  path: string,
  bytes: Uint8Array
): Promise<{ ok: true; size: number } | { ok: false; reason: string }> => {
  const transferId = crypto.randomUUID();
  const digest = await sha256Hex(bytes);
  let offset = 0;
  let seq = 0;
  for (;;) {
    const end = Math.min(offset + FILE_CHUNK_BYTES, bytes.length);
    const final = end === bytes.length;
    // Chunks go one at a time: each waits for the one before it, in order.
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    const outcome = await call(transport, "file_put", {
      data_b64: toBase64(bytes.subarray(offset, end)),
      final,
      path,
      seq,
      sha256: final ? digest : null,
      transfer_id: transferId,
    });
    if (outcome.failed) {
      return { ok: false, reason: outcome.reason };
    }
    if (final) {
      return { ok: true, size: bytes.length };
    }
    offset = end;
    seq += 1;
  }
};

/** The read loop: chunks until `eof`, refusing once the file is over `maxBytes`. */
const readBytes = async (
  transport: Transport,
  path: string,
  maxBytes: number
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> => {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let declaredSize: number | null = null;
  for (;;) {
    // Chunks are read in order: each offset depends on the bytes before it.
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design
    const outcome = await readChunk(transport, path, offset, FILE_CHUNK_BYTES);
    if (outcome.failed) {
      return { ok: false, reason: outcome.reason };
    }
    const { result } = outcome;
    if (
      typeof result.data_b64 !== "string" ||
      typeof result.size !== "number"
    ) {
      return { ok: false, reason: MALFORMED };
    }
    declaredSize ??= result.size;
    if (declaredSize > maxBytes) {
      return {
        ok: false,
        reason: `File is ${declaredSize} bytes, over the ${maxBytes} byte limit.`,
      };
    }
    const bytes = fromBase64(result.data_b64);
    parts.push(bytes);
    offset += bytes.length;
    if (offset > maxBytes) {
      return { ok: false, reason: `File is over the ${maxBytes} byte limit.` };
    }
    if (result.eof === true || bytes.length === 0) {
      return { bytes: concatBytes(parts), ok: true };
    }
  }
};

const LISTING_LINE = /^(\S) (\d+) ([\s\S]*)$/;

const parseListing = (stdout: string): DirEntry[] =>
  stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => {
      const match = LISTING_LINE.exec(entry);
      if (!match) {
        return [];
      }
      return [
        {
          directory: match[1] === "d",
          name: match[3] ?? "",
          size: Number(match[2]),
        },
      ];
    });

/**
 * The backend the tools use, over `exec`, `cancel`, `file_put` and `file_get`.
 * Path rules, size caps and the activity log are the client's job (`client.ts`)
 * and are applied before any of this runs.
 */
export const createRemoteBackend = (
  transport: Transport,
  root: SessionRoot
): ComputerBackend => {
  /** The absolute path on the host for an agent-relative path, or the reason there is none. */
  const hostPath = async (
    path: string
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
    const base = await root();
    return base.ok ? { ok: true, path: `${base.path}${path}` } : base;
  };

  const writeBytes = async (
    path: string,
    bytes: Uint8Array,
    createdCheck: boolean
  ): Promise<WriteResult> => {
    const target = await hostPath(path);
    if (!target.ok) {
      return target;
    }
    const created = createdCheck
      ? await isMissing(transport, target.path)
      : false;
    const made = await execCommand(
      transport,
      null,
      `mkdir -p ${shellQuote(parentOf(target.path))}`,
      undefined
    );
    if (!made.ok) {
      return { ok: false, reason: made.reason };
    }
    const put = await putBytes(transport, target.path, bytes);
    return put.ok ? { created, ok: true, size: put.size } : put;
  };

  return {
    async editFile(path, oldString, newString) {
      const read = await this.readFile(path, MAX_FILE_BYTES);
      if (!read.ok) {
        return read;
      }
      const occurrences = read.content.split(oldString).length - 1;
      if (occurrences === 0) {
        return { ok: false, reason: `old_string was not found in ${path}.` };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          reason: `old_string appears ${occurrences} times in ${path}; include enough surrounding context to make it unique.`,
        };
      }
      const after = read.content.replace(oldString, newString);
      return await writeBytes(path, new TextEncoder().encode(after), false);
    },

    async exec(command, timeoutMs) {
      const base = await root();
      if (!base.ok) {
        return base;
      }
      return await execCommand(transport, base.path, command, timeoutMs);
    },

    async listDir(path) {
      const target = await hostPath(path);
      if (!target.ok) {
        return target;
      }
      // A directory that does not exist yet is empty, not an error.
      const quoted = shellQuote(target.path);
      const listing = await execCommand(
        transport,
        null,
        `if [ -d ${quoted} ]; then find ${quoted} -mindepth 1 -maxdepth 1 -printf '%y %s %f\\0'; fi`,
        undefined
      );
      if (!listing.ok) {
        return { ok: false, reason: listing.reason };
      }
      return {
        entries: parseListing(listing.stdout),
        ok: true,
      } satisfies ListResult;
    },

    async readFile(path, maxBytes) {
      const target = await hostPath(path);
      if (!target.ok) {
        return target;
      }
      const read = await readBytes(transport, target.path, maxBytes);
      if (!read.ok) {
        return read;
      }
      return {
        content: new TextDecoder().decode(read.bytes),
        ok: true,
        size: read.bytes.length,
      } satisfies ReadResult;
    },

    async writeFile(path, content) {
      return await writeBytes(path, new TextEncoder().encode(content), true);
    },

    async writeFileBytes(path, bytes) {
      return await writeBytes(path, bytes, true);
    },
  };
};

export type PingResult =
  | { ok: true; hostname: null; uptimeMs: null; version: null }
  | { ok: false; reason: string };

/**
 * "Is anything there?" for the Test connection button. A no-op command proves
 * the host answers and runs commands; it reports nothing else.
 */
export const ping = async (transport: Transport): Promise<PingResult> => {
  const outcome = await execCommand(transport, null, "true", PING_TIMEOUT_MS);
  return outcome.ok
    ? { hostname: null, ok: true, uptimeMs: null, version: null }
    : { ok: false, reason: outcome.reason };
};
