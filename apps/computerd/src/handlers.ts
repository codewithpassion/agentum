/**
 * The protocol's one entry point. Both transports parse a frame into `unknown`
 * and hand it here; everything below - path rules, the exec queue, the wording
 * of every failure - is shared, so listen mode and connect mode cannot drift
 * apart.
 *
 * Nothing throws: a request that makes no sense comes back as
 * `{ ok: false, reason }` with the sender's `id`, the same as a file that is not
 * there. A daemon that 500s on a malformed frame tells the agent nothing.
 */

import { hostname } from "node:os";
import { createExecRunner } from "./exec";
import { editFileOp, listDirOp, readFileOp, writeFileOp } from "./files";
import type { OpResponse, OpResult } from "./protocol";
import { VERSION } from "./version";

export interface HandlerOptions {
  /** Ceiling on any single `exec`, from `COMPUTERD_MAX_EXEC_MS`. */
  execMaxMs: number;
  /** Absolute, already resolved: every request path lands under it. */
  root: string;
}

export type Handle = (raw: unknown) => Promise<OpResponse>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Ids are opaque to the daemon - they only have to come back unchanged - so a
 * sender that numbers its requests is accommodated rather than refused.
 */
const requestId = (raw: unknown): string => {
  if (typeof raw === "string") {
    return raw;
  }
  return typeof raw === "number" ? String(raw) : "";
};

const describe = (op: unknown): string =>
  typeof op === "string" ? `"${op}"` : "none";

export const createHandlers = (options: HandlerOptions): Handle => {
  const runExec = createExecRunner(options.root, options.execMaxMs);
  const startedAt = Date.now();

  const run = (request: Record<string, unknown>): Promise<OpResult> => {
    const { root } = options;
    switch (request.op) {
      case "read":
        return readFileOp(root, request.path, request.maxBytes);
      case "write":
        return writeFileOp(
          root,
          request.path,
          request.content,
          request.encoding
        );
      case "edit":
        return editFileOp(
          root,
          request.path,
          request.oldString,
          request.newString
        );
      case "list":
        return listDirOp(root, request.path);
      case "exec":
        return runExec({
          command: request.command,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
        });
      case "ping":
        return Promise.resolve({
          hostname: hostname(),
          ok: true,
          uptimeMs: Date.now() - startedAt,
          version: VERSION,
        });
      default:
        return Promise.resolve({
          ok: false,
          reason: `Unknown op: ${describe(request.op)}.`,
        });
    }
  };

  return async (raw) => {
    if (!isRecord(raw)) {
      return {
        id: "",
        result: { ok: false, reason: "A request must be a JSON object." },
      };
    }
    const id = requestId(raw.id);
    try {
      return { id, result: await run(raw) };
    } catch (error) {
      // The filesystem has surprises the checks above cannot pre-empt - writing
      // through a path whose parent is a file, a file that vanishes mid-read, a
      // full disk. Every one of them still has to come back as a reply: a
      // sender waiting on this id would otherwise wait until its own timeout.
      return {
        id,
        result: {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
};
