/**
 * What an outbound A2A test runs against: the inbound fixture's real runs,
 * requests, events and connections services, an outbound service over the
 * same database, and a fake peer that speaks JSON-RPC at `https://peer.test`.
 * Test code only.
 */
import type { A2aFetch } from "@repo/a2a/peer-fetch";
import type { Task } from "@repo/a2a/tasks";
import { a2aConnections } from "@repo/db/schema/a2a";
import { eq } from "drizzle-orm";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import type { ReplyTarget } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { createOutboundService } from "./outbound.ts";
import { createOutboxService } from "./outbox.ts";
import {
  AGENT,
  createFixture,
  member,
  SECRETS_KEY,
  WORKSPACE,
} from "./tasks-fixture.ts";

export const PEER_ORIGIN = "https://peer.test";
export const PEER_RPC = `${PEER_ORIGIN}/rpc`;
export const BASE_URL = "https://hm.test";
export const OUTBOUND_CONNECTION = "con_peer";

export interface PeerCall {
  authorization: string | null;
  headers: Record<string, string>;
  method: string;
  params: Record<string, unknown>;
  url: string;
}

export interface FakePeer {
  calls: PeerCall[];
  fetch: A2aFetch;
  /** Ends a task the way the peer would. */
  finish: (taskId: string, text: string) => void;
  /** Whether `CreateTaskPushNotificationConfig` is refused. */
  refusePush: boolean;
  /** What `SendMessage` does next: answer with a task (default), time out after making the task, or fail. */
  sendMessage: "error" | "message" | "task" | "timeout";
  /** Changes the state of a task. */
  setState: (taskId: string, state: Task["status"]["state"]) => void;
  /** The state a new task starts in. */
  startState: Task["status"]["state"];
  /** The tasks the peer holds. */
  tasks: Map<string, Task>;
}

const rpcResult = (id: unknown, result: unknown): Response =>
  Response.json({ id, jsonrpc: "2.0", result });

const rpcError = (id: unknown, code: number, message: string): Response =>
  Response.json({ error: { code, message }, id, jsonrpc: "2.0" });

/** A peer with Hermes's habits: JSON-RPC only, errors without `data`. */
export const createFakePeer = (): FakePeer => {
  let counter = 0;
  const peer: FakePeer = {
    calls: [],
    fetch: (url, init) => {
      const sent = new Headers(init.headers);
      const headers = Object.fromEntries(sent);
      const body = JSON.parse(String(init.body ?? "{}")) as {
        id: unknown;
        method: string;
        params: Record<string, unknown>;
      };
      peer.calls.push({
        authorization: sent.get("authorization"),
        headers,
        method: body.method,
        params: body.params,
        url,
      });
      return Promise.resolve(handle(body));
    },
    finish: (taskId, text) => {
      const task = peer.tasks.get(taskId);
      if (task) {
        peer.tasks.set(taskId, {
          ...task,
          artifacts: [{ artifactId: "a1", parts: [{ text }] }],
          status: { state: "TASK_STATE_COMPLETED" },
        });
      }
    },
    refusePush: false,
    sendMessage: "task",
    setState: (taskId, state) => {
      const task = peer.tasks.get(taskId);
      if (task) {
        peer.tasks.set(taskId, { ...task, status: { state } });
      }
    },
    startState: "TASK_STATE_WORKING",
    tasks: new Map(),
  };

  const makeTask = (params: Record<string, unknown>): Task => {
    counter += 1;
    const message = params.message as {
      contextId?: string;
    };
    const task: Task = {
      contextId: message.contextId,
      id: `rt-${counter}`,
      status: { state: peer.startState },
    };
    peer.tasks.set(task.id, task);
    return task;
  };

  const handle = (body: {
    id: unknown;
    method: string;
    params: Record<string, unknown>;
  }): Response => {
    switch (body.method) {
      case "SendMessage": {
        if (peer.sendMessage === "error") {
          return rpcError(body.id, -32_603, "Internal error");
        }
        const task = makeTask(body.params);
        if (peer.sendMessage === "timeout") {
          throw new DOMException("The operation timed out.", "TimeoutError");
        }
        if (peer.sendMessage === "message") {
          peer.tasks.delete(task.id);
          return rpcResult(body.id, {
            message: {
              messageId: "reply-1",
              parts: [{ text: "Hello back" }],
              role: "ROLE_AGENT",
            },
          });
        }
        return rpcResult(body.id, { task });
      }
      case "GetTask": {
        const task = peer.tasks.get(String(body.params.id));
        return task
          ? rpcResult(body.id, task)
          : rpcError(body.id, -32_001, "Task not found");
      }
      case "ListTasks": {
        const tasks = [...peer.tasks.values()].filter(
          (task) => task.contextId === body.params.contextId
        );
        return rpcResult(body.id, { tasks });
      }
      case "CreateTaskPushNotificationConfig":
        return peer.refusePush
          ? rpcError(body.id, -32_003, "Push not supported")
          : rpcResult(body.id, {
              configId: "cfg-1",
              createdAt: "2026-11-01T10:00:00Z",
              pushNotificationConfig: { url: String(body.params.url) },
              taskId: body.params.taskId,
            });
      default:
        return rpcError(body.id, -32_601, "Method not found");
    }
  };

  return peer;
};

/** The card an outbound connection stores: JSON-RPC at `PEER_RPC`, push on. */
export const peerCard = (push = true) => ({
  capabilities: { pushNotifications: push, streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  description: "A fake peer",
  name: "Fake Peer",
  securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
  skills: [{ description: "Does things", id: "s1", name: "s1", tags: ["t"] }],
  supportedInterfaces: [
    { protocolBinding: "JSONRPC", protocolVersion: "1.0", url: PEER_RPC },
  ],
  version: "1.0.0",
});

export const createOutboundFixture = async () => {
  // A slack reply target, so a wake has somewhere to carry the answer. Nothing is delivered.
  const f = await createFixture({
    gateways: [{ deliver: () => Promise.resolve(), kind: "slack" }],
  });
  const peer = createFakePeer();
  const key = await importSecretsKey(SECRETS_KEY);

  /** An outbound service over the same database, as `composeWith` builds one per request. */
  const newOutbound = () =>
    createOutboundService({
      clock: f.clock,
      db: f.db,
      events: f.events,
      fetch: peer.fetch,
      publicBaseUrl: BASE_URL,
      requests: f.requests,
      runs: { startRun: (p, i, o) => f.runs.startRun(p, i, o) },
      secretsKey: SECRETS_KEY,
    });
  const outbound = newOutbound();
  f.events.onAppend(outbound.onEvent);
  f.connections.onRevoked(outbound.onConnectionRevoked);
  const outbox = createOutboxService({
    activation: f.connections,
    clock: f.clock,
    db: f.db,
    events: f.events,
    fetch: peer.fetch,
    secretsKey: SECRETS_KEY,
  });

  /** An active outside-agent connection that takes a bearer token. */
  const connectPeer = async (
    overrides: Partial<typeof a2aConnections.$inferInsert> & {
      credential?: string | null;
    } = {}
  ) => {
    const { credential, ...rest } = overrides;
    const id = rest.id ?? OUTBOUND_CONNECTION;
    const token = credential === undefined ? "peer-secret" : credential;
    await f.db.insert(a2aConnections).values({
      approvedAt: "2026-11-01T10:00:00.000Z",
      approvedBy: "u-owner",
      createdAt: "2026-11-01T10:00:00.000Z",
      createdBy: "u-owner",
      id,
      localAgentId: AGENT,
      outboundCredential:
        token === null
          ? null
          : await encryptSecret(
              key,
              {
                field: "outbound_credential",
                rowId: id,
                table: "a2a_connections",
                workspaceId: WORKSPACE,
              },
              token
            ),
      outboundPolicy: "auto",
      outboundScheme: "bearer",
      peerCard: JSON.stringify(peerCard()),
      peerCardUrl: `${PEER_ORIGIN}/.well-known/agent-card.json`,
      peerKind: "a2a_outbound",
      peerLabel: "Fake Peer",
      peerOrigin: PEER_ORIGIN,
      slug: id,
      status: "active",
      workspaceId: WORKSPACE,
      ...rest,
    });
    return id;
  };

  /** A run of the agent that is running, and the principal it calls with. */
  const callingRun = async (
    options: { reply?: ReplyTarget } = {}
  ): Promise<{
    principal: Extract<Principal, { kind: "run" }>;
    runId: string;
    sessionId: string;
  }> => {
    const started = await f.runs.startRun(member(), {
      agentId: AGENT,
      input: { text: "Ask the peer" },
      ...(options.reply ? { reply: options.reply } : {}),
      session: { origin: "ui" },
    });
    await f.runs.claimRun(f.system, started.runId);
    return {
      principal: {
        agentId: AGENT,
        kind: "run",
        runId: started.runId,
        workspaceId: WORKSPACE,
      },
      runId: started.runId,
      sessionId: started.sessionId,
    };
  };

  const setConnection = (
    id: string,
    values: Partial<typeof a2aConnections.$inferInsert>
  ) => f.db.update(a2aConnections).set(values).where(eq(a2aConnections.id, id));

  return {
    ...f,
    callingRun,
    connectPeer,
    newOutbound,
    outbound,
    outbox,
    peer,
    setConnection,
  };
};

export type OutboundFixture = Awaited<ReturnType<typeof createOutboundFixture>>;
export type { Fixture } from "./tasks-fixture.ts";
