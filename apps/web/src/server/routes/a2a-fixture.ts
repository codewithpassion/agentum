// What the `/a2a` route tests run against: the real services over `migrated()`,
// the real route app from `mountA2aRoutes`, and helpers that send a request the
// way an outside client does. Test code only.
import { sqliteAtomic } from "@repo/db/atomic";
import type { A2aTaskState } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal } from "@repo/services/workspaces";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono/types";
import { type Composed, composeWith } from "../compose.ts";
import { type A2aRoutesOptions, mountA2aRoutes } from "./a2a.ts";
import type { AppEnv } from "./groups.ts";

export const ORIGIN = "https://hm.test";
export const SECRETS_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7))
);
/** An agent's private instructions. A card or an answer that shows them is a leak. */
export const INSTRUCTIONS = "PRIVATE-INSTRUCTIONS-NEVER-PUBLISH";
const SKILLS = [
  {
    description: "Answers questions.",
    id: "ask",
    name: "Ask",
    tags: ["support"],
  },
];

export type A2aFixture = Awaited<ReturnType<typeof createA2aFixture>>;

export interface Published {
  agentId: string;
  publicId: string;
}

export const createA2aFixture = async (options: A2aRoutesOptions = {}) => {
  const db = migrated(["org_a", "org_b"]);
  const store = new Map<string, string>();
  const composed: Composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      publicBaseUrl: ORIGIN,
      relay: noopRelay,
      secretsKey: SECRETS_KEY,
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a has no workspace row");
  }
  const workspaceId = workspace.id;
  const other = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_b",
  });
  if (!other) {
    throw new Error("org_b has no workspace row");
  }
  /** An admin of a second workspace on the same deployment, the other side of a pairing. */
  const bob: Principal = {
    isAdmin: true,
    kind: "user",
    userId: "u-bob",
    via: "session",
    workspaceId: other.id,
  };
  /** An admin on a browser session: may publish, connect and widen. */
  const admin: Principal = {
    isAdmin: true,
    kind: "user",
    userId: "u-admin",
    via: "session",
    workspaceId,
  };
  /** Any member on a session: may approve and decline a waiting message. */
  const member: Principal = {
    isAdmin: false,
    kind: "user",
    userId: "u-member",
    via: "session",
    workspaceId,
  };
  const compose: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("composed", composed);
    await next();
  };
  const app = new Hono<AppEnv>();
  mountA2aRoutes(app, compose, options);

  /** A published agent on the fake runtime, which answers `Echo: <text>` at once. */
  const publish = async (
    slug: string,
    owner: Principal = admin
  ): Promise<Published> => {
    const agent = await composed.services.agents.create(owner, {
      instructions: INSTRUCTIONS,
      model: "fake",
      name: `Agent ${slug}`,
      runtime: "fake",
      slug,
    });
    const card = await composed.services.connections.publish(owner, {
      agentId: agent.id,
      description: `Agent ${slug} answers questions.`,
      skills: SKILLS,
    });
    return { agentId: agent.id, publicId: card.publicId };
  };

  /** An access key for the agent. `inbound` is the policy: a message waits for a person under `approve` and starts a run under `auto`. */
  const connect = async (
    agent: Published,
    inbound: "approve" | "auto" = "auto",
    label = "Hermes"
  ) => {
    const key = await composed.services.connections.createAccessKey(admin, {
      agentId: agent.agentId,
      label,
    });
    if (inbound !== "approve") {
      await composed.services.connections.setPolicies(admin, {
        connectionId: key.connection.id,
        inboundPolicy: inbound,
      });
    }
    return { connectionId: key.connection.id, token: key.token };
  };

  const headers = (
    token: string | null,
    extra: Record<string, string> = {}
  ): Record<string, string> => ({
    "A2A-Version": "1.0",
    "Content-Type": "application/json",
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    ...extra,
  });

  /** One JSON-RPC call. */
  const rpc = (
    publicId: string,
    token: string | null,
    method: string,
    params: unknown = {},
    extra: Record<string, string> = {}
  ) =>
    app.request(`/a2a/${publicId}/rpc`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: headers(token, extra),
      method: "POST",
    });

  /** One HTTP+JSON call. `path` is under `/rest`, such as `/tasks/abc:cancel`. */
  const rest = (
    publicId: string,
    token: string | null,
    method: "DELETE" | "GET" | "POST",
    path: string,
    body?: unknown,
    extra: Record<string, string> = {}
  ) =>
    app.request(`/a2a/${publicId}/rest${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: headers(token, extra),
      method,
    });

  let seeded = 0;
  /**
   * A task row on a connection, in any state, with no run behind it. A test
   * that needs a task which stays `TASK_STATE_WORKING` makes one here, because
   * the fake runtime finishes a real run at once.
   */
  const seedTask = (
    connectionId: string,
    state: A2aTaskState,
    extra: { contextId?: string; resultText?: string; statusText?: string } = {}
  ): Promise<string> => {
    seeded += 1;
    const id = `tsk_seed${seeded}`;
    const now = new Date().toISOString();
    // Plain SQL: the app reaches the tables through services, and a test row
    // with no run behind it is something no service writes.
    db.run(
      sql`insert into a2a_tasks (id, workspace_id, connection_id, context_id, message_id, input_text, state, status_text, result_text, created_at, updated_at) values (${id}, ${workspaceId}, ${connectionId}, ${extra.contextId ?? `ctx_seed${seeded}`}, ${`seed-${seeded}`}, ${"seeded"}, ${state}, ${extra.statusText ?? null}, ${extra.resultText ?? null}, ${now}, ${now})`
    );
    return Promise.resolve(id);
  };

  /** Moves a seeded task to a new state, as a run's events would. */
  const moveTask = (
    taskId: string,
    state: A2aTaskState,
    extra: { resultText?: string; statusText?: string } = {}
  ): Promise<void> => {
    db.run(
      sql`update a2a_tasks set state = ${state}, status_text = ${extra.statusText ?? null}, result_text = ${extra.resultText ?? null}, updated_at = ${new Date().toISOString()} where id = ${taskId}`
    );
    return Promise.resolve();
  };

  return {
    admin,
    app,
    bob,
    composed,
    connect,
    db,
    member,
    moveTask,
    publish,
    rest,
    rpc,
    seedTask,
    workspaceId,
  };
};

/** A plain text message as an outside client sends it. */
export const textMessage = (
  messageId: string,
  text: string,
  contextId?: string
) => ({
  message: {
    ...(contextId === undefined ? {} : { contextId }),
    messageId,
    parts: [{ text }],
    role: "ROLE_USER",
  },
});
