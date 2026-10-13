import type { Db } from "#/db/client";
import { logActivity } from "#/modules/activity/service";
import type { Agent } from "#/modules/agents/schema";
import { getAgentByIdUnscoped } from "#/modules/agents/service";
import {
  summarizeEdit,
  summarizeExec,
  summarizeExecFailure,
  summarizeWrite,
} from "./activity";
import { createFlyGateway, type FlyGatewayFactory } from "./fly-gateway";
import { createEnsureConnected, type WakeOptions } from "./fly-wake";
import { getHostByIdUnscoped, resolveFlyApiToken } from "./hosts";
import { ACTIVITY_STREAM_MAX_BYTES, truncateText } from "./output";
import {
  MAX_FILE_BYTES,
  MAX_READ_BYTES,
  validateContent,
  validatePath,
} from "./paths";
import {
  createRelaySessionRoot,
  createRelayTransport,
} from "./relay-transport";
import {
  ComputerTransportError,
  createRemoteBackend,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  type SessionRoot,
  type Transport,
} from "./remote-client";
import type { ComputerHost } from "./schema";
import type { ExecResult, ListResult, ReadResult, WriteResult } from "./types";

/**
 * The internal face of an agent's computer. Everything - MCP tools, the `/api`
 * routes, and later the UI's uploads - goes through this interface, so path
 * rules, size caps and the activity log are applied exactly once, whichever
 * backend the agent's files actually live on.
 */
export interface AgentComputerClient {
  editFile: (
    path: string,
    oldString: string,
    newString: string
  ) => Promise<WriteResult>;
  exec: (command: string, timeoutMs?: number) => Promise<ExecResult>;
  listDir: (path: string) => Promise<ListResult>;
  readFile: (path: string, maxBytes?: number) => Promise<ReadResult>;
  writeFile: (path: string, content: string) => Promise<WriteResult>;
  /**
   * The Files tab's upload: bytes rather than text, and attributed to the user,
   * so the caller writes the activity row. Everything else - the path rules,
   * the size cap, the backend - is the same as `writeFile`.
   */
  writeFileBytes: (path: string, bytes: Uint8Array) => Promise<WriteResult>;
}

/**
 * The five raw operations, with none of the rules around them: the same shape
 * the `AgentComputer` Durable Object exposes, so that stub *is* one of these,
 * and `remote-client.ts` is another over the `agentum-computer` protocol. Everything
 * a backend is trusted with is a validated path and a checked payload.
 *
 * `timeoutMs` is a request, not a promise: the Durable Object ignores it (its
 * shell has one fixed timeout), and remote backends cap it.
 */
export interface ComputerBackend {
  editFile: (
    path: string,
    oldString: string,
    newString: string
  ) => Promise<WriteResult>;
  exec: (command: string, timeoutMs?: number) => Promise<ExecResult>;
  listDir: (path: string) => Promise<ListResult>;
  readFile: (path: string, maxBytes: number) => Promise<ReadResult>;
  writeFile: (path: string, content: string) => Promise<WriteResult>;
  /**
   * Bytes, for an upload. Separate from `writeFile` because the wire formats
   * differ: the Durable Object takes a `Uint8Array`, and the protocol the
   * remote backends speak carries base64 - a `Uint8Array` through
   * `JSON.stringify` would become `{"0":1,...}` and land as a text file of
   * digits.
   */
  writeFileBytes: (path: string, bytes: Uint8Array) => Promise<WriteResult>;
}

const MAX_COMMAND_LENGTH = 4000;
const MAX_EDIT_STRING_LENGTH = 100_000;

/** Today's backend, and still the default: the agent's own Durable Object. */
const durableObjectBackend = (env: Env, agentId: string): ComputerBackend => {
  const stub = env.AGENT_COMPUTER.get(env.AGENT_COMPUTER.idFromName(agentId));
  return {
    editFile: (path, oldString, newString) =>
      stub.editFile(path, oldString, newString),
    // The DO's shell has one fixed timeout, so the request is dropped here
    // rather than pretended at: only a remote backend can honour it.
    exec: (command) => stub.exec(command),
    listDir: (path) => stub.listDir(path),
    readFile: (path, maxBytes) => stub.readFile(path, maxBytes),
    writeFile: (path, content) => stub.writeFile(path, content),
    // The DO's `writeFile` has always taken either, so bytes go straight to it.
    writeFileBytes: (path, bytes) => stub.writeFile(path, bytes),
  };
};

/**
 * A backend that refuses everything with one reason. The agent's computer is
 * misconfigured - a deleted host, a missing key, a Fly agent whose machine was
 * never created - and every path out of that is an action a person has to
 * take, so it is reported the way any other refusal is rather than thrown.
 */
const failingBackend = (reason: string): ComputerBackend => ({
  editFile: () => Promise.resolve({ ok: false, reason }),
  exec: () => Promise.resolve({ ok: false, reason }),
  listDir: () => Promise.resolve({ ok: false, reason }),
  readFile: () => Promise.resolve({ ok: false, reason }),
  writeFile: () => Promise.resolve({ ok: false, reason }),
  writeFileBytes: () => Promise.resolve({ ok: false, reason }),
});

/**
 * How to reach one host's client: through the relay, for both kinds. The client
 * dials out, so a Fly machine and a container on someone's desk look the same
 * from here. `agentId` is the agent whose operations these are.
 */
export const transportForHost = (
  env: Env,
  host: ComputerHost,
  agentId?: string
): Transport => createRelayTransport(env, host.id, agentId);

/** Test seams for the Fly wake path; production passes none. */
export interface ComputerClientDeps {
  createFlyGateway?: FlyGatewayFactory;
  wake?: Pick<WakeOptions, "pollMs" | "sleep" | "timeoutMs">;
}

/**
 * Wraps a Fly agent's transport and session root so that an operation on a
 * machine whose client is not connected starts the machine first.
 */
const wakingParts = (
  env: Env,
  host: ComputerHost,
  agent: Agent,
  machineId: string,
  deps: ComputerClientDeps
): { root: SessionRoot; transport: Transport } => {
  const stub = env.COMPUTER_RELAY.get(env.COMPUTER_RELAY.idFromName(host.id));
  const ensureConnected = createEnsureConnected({
    ...deps.wake,
    isConnected: async () => (await stub.status()).connected,
    label: `${agent.name}'s computer on Fly host "${host.name}"`,
    start: async () => {
      const apiToken = await resolveFlyApiToken(env, host);
      if (!(apiToken && host.config.app)) {
        throw new Error("the host has no Fly app or API token configured");
      }
      await (deps.createFlyGateway ?? createFlyGateway)(apiToken).startMachine(
        host.config.app,
        machineId
      );
    },
  });

  const inner = transportForHost(env, host, agent.id);
  const root = createRelaySessionRoot(env, host.id, agent.id);
  return {
    root: async () => {
      try {
        await ensureConnected();
      } catch (error) {
        if (error instanceof ComputerTransportError) {
          return { ok: false, reason: error.message };
        }
        throw error;
      }
      return await root();
    },
    transport: {
      send: async (message) => {
        await ensureConnected();
        return await inner.send(message);
      },
      status: () => inner.status(),
    },
  };
};

const remoteBackendFor = async (
  db: Db,
  env: Env,
  agent: Agent,
  deps: ComputerClientDeps
): Promise<ComputerBackend> => {
  if (!agent.computerHostId) {
    return failingBackend(
      `${agent.name} is set to run its computer on a ${agent.computer} host, but no host is recorded on the agent.`
    );
  }
  const host = await getHostByIdUnscoped(db, agent.computerHostId);
  if (!host) {
    return failingBackend(
      `${agent.name}'s computer host no longer exists. Add it again in Settings and recreate the agent.`
    );
  }
  if (host.kind === "self_hosted") {
    return createRemoteBackend(
      transportForHost(env, host, agent.id),
      createRelaySessionRoot(env, host.id, agent.id)
    );
  }
  const machineId = agent.computerRef?.machineId;
  if (!machineId) {
    return failingBackend(
      `No machine has been created for ${agent.name} on host "${host.name}" yet.`
    );
  }
  const { root, transport } = wakingParts(env, host, agent, machineId, deps);
  return createRemoteBackend(transport, root);
};

const backendFor = (
  db: Db,
  env: Env,
  agent: Agent,
  deps: ComputerClientDeps
): Promise<ComputerBackend> =>
  agent.computer === "cloudflare"
    ? Promise.resolve(durableObjectBackend(env, agent.id))
    : remoteBackendFor(db, env, agent, deps);

/** Nonsense timeouts are dropped rather than argued with; the cap is the plan's. */
const clampTimeout = (timeoutMs: number | undefined): number | undefined => {
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return;
  }
  return Math.min(Math.floor(timeoutMs), REMOTE_EXEC_MAX_TIMEOUT_MS);
};

/**
 * The dispatcher. It loads the agent - unscoped, because this is server-side
 * plumbing whose callers have already proved the tenant - and picks the
 * backend from `agent.computer`, then wraps it in the rules every computer
 * shares.
 *
 * An agent id that resolves to nothing throws rather than falling back: a
 * Durable Object named after an id that does not exist is an empty filesystem,
 * which would look like an agent that lost its files.
 */
export const createComputerClient = async (
  db: Db,
  env: Env,
  agentId: string,
  deps: ComputerClientDeps = {}
): Promise<AgentComputerClient> => {
  const agent = await getAgentByIdUnscoped(db, agentId);
  if (!agent) {
    throw new Error(`No agent ${agentId}: its computer cannot be resolved.`);
  }
  const backend = await backendFor(db, env, agent, deps);

  return {
    async editFile(path, oldString, newString) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      if (typeof oldString !== "string" || oldString.length === 0) {
        return { ok: false, reason: "old_string is required." };
      }
      if (
        oldString.length > MAX_EDIT_STRING_LENGTH ||
        (newString?.length ?? 0) > MAX_EDIT_STRING_LENGTH
      ) {
        return {
          ok: false,
          reason: `old_string and new_string must each be at most ${MAX_EDIT_STRING_LENGTH} characters.`,
        };
      }

      const result = await backend.editFile(target.path, oldString, newString);
      if (result.ok) {
        await logActivity(db, {
          agentId,
          detail: { path: target.path, size: result.size },
          kind: "computer.edit",
          summary: summarizeEdit({ path: target.path }),
        });
      }
      return result;
    },

    async exec(command, timeoutMs) {
      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, reason: "A command is required." };
      }
      if (command.length > MAX_COMMAND_LENGTH) {
        return {
          ok: false,
          reason: `Commands must be at most ${MAX_COMMAND_LENGTH} characters.`,
        };
      }

      const result = await backend.exec(command, clampTimeout(timeoutMs));
      if (result.ok) {
        await logActivity(db, {
          agentId,
          detail: {
            command,
            exitCode: result.exitCode,
            stderr: truncateText(result.stderr, ACTIVITY_STREAM_MAX_BYTES).text,
            stdout: truncateText(result.stdout, ACTIVITY_STREAM_MAX_BYTES).text,
          },
          kind: "computer.exec",
          summary: summarizeExec({ command, exitCode: result.exitCode }),
        });
      } else {
        await logActivity(db, {
          agentId,
          detail: { command, error: result.reason },
          kind: "computer.exec",
          summary: summarizeExecFailure({ command, reason: result.reason }),
        });
      }
      return result;
    },

    async listDir(path) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      return await backend.listDir(target.path);
    },

    async readFile(path, maxBytes = MAX_READ_BYTES) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      return await backend.readFile(target.path, maxBytes);
    },

    async writeFile(path, content) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      const body = validateContent(content);
      if (!body.ok) {
        return body;
      }

      const result = await backend.writeFile(target.path, body.content);
      if (result.ok) {
        await logActivity(db, {
          agentId,
          detail: {
            created: result.created,
            path: target.path,
            size: result.size,
          },
          kind: "computer.write",
          summary: summarizeWrite({
            created: result.created,
            path: target.path,
            size: result.size,
          }),
        });
      }
      return result;
    },

    async writeFileBytes(path, bytes) {
      const target = validatePath(path);
      if (!target.ok) {
        return target;
      }
      if (bytes.byteLength > MAX_FILE_BYTES) {
        return {
          ok: false,
          reason: `Files must be at most ${MAX_FILE_BYTES} bytes.`,
        };
      }
      // No activity row here: an upload is the user's action, not the agent's,
      // and the route that has the user records it as such.
      return await backend.writeFileBytes(target.path, bytes);
    },
  };
};
