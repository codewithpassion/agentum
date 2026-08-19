import { DurableObject } from "cloudflare:workers";
import {
  getWorkspace,
  type WorkspaceOptions,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { byteLength } from "./paths";
import {
  EXEC_UNAVAILABLE,
  type ExecResult,
  type ListResult,
  type ReadResult,
  type WriteResult,
} from "./types";

/**
 * One agent's computer: a SQLite-backed filesystem living in this Durable
 * Object (`idFromName(agentId)`), plus a shell that runs against those same
 * files. `@cloudflare/computer` is preview software, so it is imported here and
 * nowhere else - `modules/computer` is the only thing that would have to change
 * if its API moves.
 *
 * Every method returns plain values. Stubs handed across the Worker -> DO
 * boundary are not garbage-collected, so keeping them inside this class means
 * callers cannot leak one, and truncation happens before anything crosses.
 */

const EXEC_TIMEOUT_MS = 30_000;

/**
 * Recognises a runtime with no execution backend registered. The workspace
 * throws rather than offering a "can this exec?" query, so the message is the
 * only signal there is.
 */
const BACKEND_MISSING = /backend/i;

const isBackendMissing = (error: unknown): boolean =>
  BACKEND_MISSING.test(error instanceof Error ? error.message : String(error));

/** The part of a stat result this module uses; the package does not export the type. */
interface StatLike {
  isDirectory: boolean;
  size: number;
}

/**
 * `fs.stat` rejects on a missing path and the workspace client has no
 * `exists`, so "is it there?" is a caught rejection either way.
 */
const statOrNull = async (
  fs: { stat: (path: string) => Promise<StatLike> },
  path: string
): Promise<StatLike | null> => {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
};

/** Byte size of what was just written, so a stat round trip is not needed. */
const sizeOf = (content: string | Uint8Array): number =>
  typeof content === "string" ? byteLength(content) : content.byteLength;

/**
 * `ctx` and `env` are protected on `DurableObject`, and `withWorkspace` builds
 * its options from outside the class - hence the public aliases.
 */
class AgentComputerBase extends DurableObject<Env> {
  readonly bindings: Env;
  readonly state: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
    this.state = ctx;
  }
}

const workspaceOptions = (self: AgentComputerBase): WorkspaceOptions => ({
  // No Worker Loader binding (no `experimental` flag) means no shell: the
  // filesystem still works and `exec` degrades to a clear error.
  backends: self.bindings.LOADER
    ? [
        new WorkerShellBackend({
          ctx: self.state,
          loader: self.bindings.LOADER,
          workspace: {
            binding: "AGENT_COMPUTER",
            id: self.state.id.toString(),
          },
        }),
      ]
    : [],
  // The package types `storage` with its own generic `Row` on `sql.exec`,
  // which the runtime's `DurableObjectStorage` cannot satisfy structurally
  // (the generic is only assignable in one direction). The value is exactly
  // what the package asks for; only the declaration disagrees.
  storage: self.state.storage as WorkspaceOptions["storage"],
});

export class AgentComputer extends withWorkspace(
  AgentComputerBase,
  workspaceOptions
) {
  /**
   * Resolves to the in-process workspace, so nothing here crosses an RPC
   * boundary; the `using` still holds, because the client is disposable either
   * way.
   */
  private workspace() {
    return getWorkspace(this);
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    using ws = await this.workspace();
    const stat = await statOrNull(ws.fs, path);
    if (!stat) {
      return { ok: false, reason: `No such file: ${path}` };
    }
    if (stat.isDirectory) {
      return { ok: false, reason: `${path} is a directory.` };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        reason: `${path} is ${stat.size} bytes, over the ${maxBytes} byte read limit.`,
      };
    }
    return {
      content: await ws.fs.readFile(path, "utf8"),
      ok: true,
      size: stat.size,
    };
  }

  async writeFile(
    path: string,
    content: string | Uint8Array
  ): Promise<WriteResult> {
    using ws = await this.workspace();
    // The root always exists, and `mkdir("/")` rejects with EEXIST even when
    // recursive - so only intermediate directories are created here.
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) {
      await ws.fs.mkdir(parent, { recursive: true });
    }
    const existed = await statOrNull(ws.fs, path);
    await ws.fs.writeFile(path, content);
    return { created: existed === null, ok: true, size: sizeOf(content) };
  }

  /** Replaces the single occurrence of `oldString`; ambiguity is an error, not a guess. */
  async editFile(
    path: string,
    oldString: string,
    newString: string
  ): Promise<WriteResult> {
    using ws = await this.workspace();
    if ((await statOrNull(ws.fs, path)) === null) {
      return { ok: false, reason: `No such file: ${path}` };
    }
    const before = await ws.fs.readFile(path, "utf8");
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
      return { ok: false, reason: `old_string was not found in ${path}.` };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        reason: `old_string appears ${occurrences} times in ${path}; include enough surrounding context to make it unique.`,
      };
    }
    const after = before.replace(oldString, newString);
    await ws.fs.writeFile(path, after);
    return { created: false, ok: true, size: sizeOf(after) };
  }

  async listDir(path: string): Promise<ListResult> {
    using ws = await this.workspace();
    const stat = await statOrNull(ws.fs, path);
    if (!stat) {
      return { ok: false, reason: `No such directory: ${path}` };
    }
    if (!stat.isDirectory) {
      return { ok: false, reason: `${path} is a file, not a directory.` };
    }
    const entries = await ws.fs.readdir(path);
    return {
      entries: entries.map((entry) => ({
        directory: entry.isDirectory,
        name: entry.name,
        size: entry.size,
      })),
      ok: true,
    };
  }

  async exec(command: string): Promise<ExecResult> {
    using ws = await this.workspace();
    try {
      using run = await ws.runtime.exec(command, {
        encoding: "utf8",
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      const { exitCode, stderr, stdout } = await run.result();
      return {
        exitCode: exitCode ?? 0,
        ok: true,
        stderr: stderr ?? "",
        stdout: stdout ?? "",
      };
    } catch (error) {
      if (isBackendMissing(error)) {
        return { ok: false, reason: EXEC_UNAVAILABLE };
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * The worker-shell backend reaches back into this DO's filesystem through a
 * `WorkerEntrypoint` it looks up on `ctx.exports`, so the class has to be a
 * named export of the Worker entry module. Re-exported here so that
 * `@cloudflare/computer` still has exactly one import site.
 */
// biome-ignore lint/performance/noBarrelFile: the Workers runtime requires this entrypoint on the entry module
export { WorkspaceServiceProxy } from "@cloudflare/computer";
