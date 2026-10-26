// The `computer` group of the platform MCP tools: the calling run's own
// directory on one machine, over the machine relay. Logical paths map to
// `${workdir}/${agentId}` on the host. Relay refusals become typed failures the
// agent can act on. Each command and each file transfer leaves an event that
// holds no output and no file content.

import type { ComputerExecPayload, ComputerFilePayload } from "@repo/db/shared";
import type { ComputerPort, PortFailure } from "@repo/mcp/ports";
import {
  type ExecResultPayload,
  FILE_CHUNK_BYTES,
  type FileGetResultPayload,
  parseDesktopOkResult,
  parseDesktopScreenshotResult,
  parseExecResult,
  parseFileGetResult,
  parseFilePutResult,
} from "@repo/protocol/computer";
import type {
  ComputerFailureReason,
  ComputerOutcome,
  ComputerPrincipal,
  MachineRelayPort,
} from "@repo/services/machines/types";
import type { Principal } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";

/** The agent id becomes a directory name on the computer. */
const AGENT_DIR_NAME = /^[A-Za-z0-9_-]+$/;
const LIST_TIMEOUT_MS = 30_000;
const MALFORMED_REPLY =
  "The computer sent a reply this server cannot understand. Check that its version matches this deployment.";

/** A reply the port can use, or the failure to report. */
type Settled<T> = { ok: true; value: T } | PortFailure;

const CLIENT_CODES = new Map<string, PortFailure["code"]>([
  ["not_found", "not_found"],
  ["bad_request", "validation"],
  ["denied", "validation"],
  ["read_only", "validation"],
  ["too_large", "validation"],
  ["is_a_directory", "validation"],
  ["not_a_regular_file", "validation"],
  ["desktop_unavailable", "desktop_unavailable"],
]);

const REASON_CODES: Record<
  Exclude<ComputerFailureReason, "client_error">,
  PortFailure["code"]
> = {
  desktop_busy: "desktop_busy",
  desktop_unavailable: "desktop_unavailable",
  duplicate_id: "conflict",
  forbidden: "conflict",
  human_in_control: "human_in_control",
  interrupted: "offline",
  offline: "offline",
  queue_full: "conflict",
  replaced: "offline",
  revoked: "offline",
  stale: "offline",
  timeout: "timeout",
};

const failureOf = (
  outcome: Extract<ComputerOutcome, { ok: false }>
): PortFailure => ({
  code:
    outcome.reason === "client_error"
      ? (CLIENT_CODES.get(outcome.code ?? "") ?? "conflict")
      : REASON_CODES[outcome.reason],
  ok: false,
  reason: outcome.message,
});

const malformed = (): PortFailure => ({
  code: "conflict",
  ok: false,
  reason: MALFORMED_REPLY,
});

const parseReply = <T>(
  outcome: ComputerOutcome,
  parse: (json: string) => T | undefined
): Settled<T> => {
  if (!outcome.ok) {
    return failureOf(outcome);
  }
  const value = parse(outcome.resultJson);
  return value === undefined ? malformed() : { ok: true, value };
};

const decodeBase64 = (text: string): Uint8Array | null => {
  try {
    return base64ToBytes(text);
  } catch {
    return null;
  }
};

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** Single-quotes a value for `sh -c`, so no path or name can change the command. */
const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/**
 * POSIX sh only: the image ships busybox, whose find has no -printf. Each entry
 * is `type size name` followed by a NUL, so a name with spaces survives.
 */
const listScript = (dir: string): string =>
  `if [ -d ${shellQuote(dir)} ]; then cd ${shellQuote(dir)} || exit 1; for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -d "$f" ]; then t=d; s=0; else t=f; s=$(wc -c < "$f" 2>/dev/null | tr -d ' '); [ -n "$s" ] || s=0; fi; printf '%s %s %s\\0' "$t" "$s" "$f"; done; fi`;

const LISTING_LINE = /^(\S) (\d+) ([\s\S]*)$/;

const parseListing = (stdout: string) =>
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

/** The host path for a logical path under the agent's directory. */
const hostPathOf = (agentDir: string, path: string): string =>
  path === "/" ? agentDir : `${agentDir}${path}`;

export const createComputerPorts = ({
  machineId,
  principal,
  relay,
  services,
}: {
  machineId: string;
  principal: Extract<Principal, { kind: "run" }>;
  relay: MachineRelayPort;
  services: Pick<Services, "events">;
}): ComputerPort => {
  const agentPrincipal: ComputerPrincipal = {
    agentId: principal.agentId,
    kind: "agent",
  };
  const actor = { id: principal.agentId, kind: "agent" } as const;
  const scope = {
    agentId: principal.agentId,
    runId: principal.runId,
    workspaceId: principal.workspaceId,
  };

  /** The directory this agent's files live in on the host, or why there is none. */
  const agentDir = async (): Promise<
    { ok: true; dir: string } | PortFailure
  > => {
    if (!AGENT_DIR_NAME.test(principal.agentId)) {
      return {
        code: "validation",
        ok: false,
        reason: "This agent's id cannot name a directory on the computer.",
      };
    }
    const { workdir } = await relay.computerStatus(machineId);
    if (workdir === null) {
      return {
        code: "offline",
        ok: false,
        reason: "The computer has not reported its working directory yet.",
      };
    }
    return { dir: `${workdir}/${principal.agentId}`, ok: true };
  };

  const execReply = async (
    command: string,
    cwd: string | null,
    timeoutMs: number
  ): Promise<Settled<ExecResultPayload>> =>
    parseReply(
      await relay.computerExec(machineId, agentPrincipal, {
        command,
        cwd,
        env: {},
        timeout_ms: timeoutMs,
      }),
      parseExecResult
    );

  const getChunk = async (
    path: string,
    offset: number,
    maxBytes: number
  ): Promise<Settled<FileGetResultPayload>> =>
    parseReply(
      await relay.fileGet(machineId, agentPrincipal, {
        max_bytes: maxBytes,
        offset,
        path,
      }),
      parseFileGetResult
    );

  /** Whether the path is absent, judged by the daemon's own `not_found` answer. */
  const isMissing = async (path: string): Promise<boolean> => {
    const probe = await relay.fileGet(machineId, agentPrincipal, {
      max_bytes: 1,
      offset: 0,
      path,
    });
    return !probe.ok && probe.code === "not_found";
  };

  /**
   * Reads chunks until eof. A file over `maxBytes` is not read past its first
   * chunk, so the caller learns its size without transferring it.
   */
  const readBytes = async (
    path: string,
    maxBytes: number
  ): Promise<Settled<{ bytes: Uint8Array; size: number }>> => {
    const first = await getChunk(path, 0, FILE_CHUNK_BYTES);
    if (!first.ok) {
      return first;
    }
    const { size } = first.value;
    if (size > maxBytes) {
      return { ok: true, value: { bytes: new Uint8Array(0), size } };
    }
    const parts: Uint8Array[] = [];
    let offset = 0;
    let chunk: Settled<FileGetResultPayload> = first;
    for (;;) {
      if (!chunk.ok) {
        return chunk;
      }
      const bytes = decodeBase64(chunk.value.data_b64);
      if (bytes === null) {
        return malformed();
      }
      parts.push(bytes);
      offset += bytes.length;
      if (chunk.value.eof || bytes.length === 0 || offset > maxBytes) {
        break;
      }
      // Chunks are read in order: each offset depends on the bytes before it.
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design
      chunk = await getChunk(path, offset, FILE_CHUNK_BYTES);
    }
    return { ok: true, value: { bytes: concatBytes(parts), size } };
  };

  /**
   * Writes bytes in `FILE_CHUNK_BYTES` pieces that share one transfer id. The
   * whole-file digest goes on the final chunk only.
   */
  const putBytes = async (
    path: string,
    bytes: Uint8Array
  ): Promise<PortFailure | null> => {
    const transferId = crypto.randomUUID();
    const digest = await sha256Hex(bytes);
    let offset = 0;
    let seq = 0;
    for (;;) {
      const end = Math.min(offset + FILE_CHUNK_BYTES, bytes.length);
      const final = end === bytes.length;
      // Chunks go one at a time: each waits for the one before it, in order.
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design
      const outcome = await relay.filePut(machineId, agentPrincipal, {
        data_b64: bytesToBase64(bytes.subarray(offset, end)),
        final,
        path,
        seq,
        sha256: final ? digest : null,
        transfer_id: transferId,
      });
      if (!outcome.ok) {
        return failureOf(outcome);
      }
      if (parseFilePutResult(outcome.resultJson) === undefined) {
        return malformed();
      }
      if (final) {
        return null;
      }
      offset = end;
      seq += 1;
    }
  };

  const recordFile = (op: "get" | "put", path: string, bytes: number) =>
    services.events.append({
      actor,
      ...scope,
      payload: {
        bytes,
        machineId,
        op,
        path,
      } satisfies ComputerFilePayload,
      type: "computer.file",
    });

  return {
    desktopInput: async ({ actions }) => {
      const reply = parseReply(
        await relay.desktopInput(machineId, agentPrincipal, { actions }),
        parseDesktopOkResult
      );
      return reply.ok ? { applied: actions.length, ok: true } : reply;
    },

    exec: async ({ command, timeout_ms }) => {
      const base = await agentDir();
      if (!base.ok) {
        return base;
      }
      const started = Date.now();
      const reply = await execReply(command, base.dir, timeout_ms);
      await services.events.append({
        actor,
        ...scope,
        payload: {
          command,
          durationMs: reply.ok ? reply.value.duration_ms : Date.now() - started,
          exitCode: reply.ok ? reply.value.exit_code : null,
          machineId,
        } satisfies ComputerExecPayload,
        type: "computer.exec",
      });
      if (!reply.ok) {
        return reply;
      }
      return {
        exitCode: reply.value.exit_code,
        ok: true,
        stderr: reply.value.stderr,
        stdout: reply.value.stdout,
      };
    },

    listDir: async ({ path }) => {
      const base = await agentDir();
      if (!base.ok) {
        return base;
      }
      const reply = await execReply(
        listScript(hostPathOf(base.dir, path)),
        null,
        LIST_TIMEOUT_MS
      );
      if (!reply.ok) {
        return reply;
      }
      if (reply.value.exit_code !== 0) {
        return {
          code: "conflict",
          ok: false,
          reason:
            reply.value.stderr.trim() || "The directory could not be listed.",
        };
      }
      return { entries: parseListing(reply.value.stdout), ok: true };
    },

    readFile: async ({ maxBytes, path }) => {
      const base = await agentDir();
      if (!base.ok) {
        return base;
      }
      const read = await readBytes(hostPathOf(base.dir, path), maxBytes);
      if (!read.ok) {
        return read;
      }
      const { bytes, size } = read.value;
      await recordFile("get", path, bytes.length);
      return { content: new TextDecoder().decode(bytes), ok: true, size };
    },

    screenshot: async () => {
      const reply = parseReply(
        await relay.desktopScreenshot(machineId, agentPrincipal, {
          quality: null,
        }),
        parseDesktopScreenshotResult
      );
      if (!reply.ok) {
        return reply;
      }
      return {
        image: {
          data: reply.value.data_b64,
          mimeType: reply.value.media_type,
        },
        ok: true,
      };
    },

    writeFile: async ({ content, path }) => {
      const base = await agentDir();
      if (!base.ok) {
        return base;
      }
      const target = hostPathOf(base.dir, path);
      const bytes = new TextEncoder().encode(content);
      const created = await isMissing(target);
      const failure = await putBytes(target, bytes);
      if (failure) {
        return failure;
      }
      await recordFile("put", path, bytes.length);
      return { created, ok: true, size: bytes.length };
    },
  };
};
