import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { EVENT_QUERY_MAX_LIMIT, type EventRecord } from "@repo/services/events";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import type { Principal, Workspace } from "@repo/services/workspaces";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { SessionStream } from "../session-stream.ts";
import { createStreamCore, type StreamCore } from "../session-stream-core.ts";
import { eventFrame, STREAM_EVENT_TYPES } from "../session-stream-frames.ts";
import type { AppEnv } from "./groups.ts";
import { NO_REPLAY, relay, sessionStreamRoutes } from "./session-stream.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

type User = Extract<Principal, { kind: "user" }>;
type Session = { orgId?: string | null; userId: string | null } | null;

let db: ReturnType<typeof migrated>;
let composed: Composed;
let userA: User;
let agentId: string;
let currentSession: Session;
let core: StreamCore;
let subscriptions: number;
/** Runs after the stream is subscribed and before its D1 read. */
let onSubscribe: () => void;

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
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
    fileBlobs: {
      delete: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
    relay: noopRelay,
    runTokenKey: KEY,
  };
};

/**
 * A stand-in for the SessionStream namespace. Each stub subscribes to the
 * shared core, the way the real Durable Object's `fetch` does.
 */
const fakeNamespace = {
  get: () => ({
    fetch: (): Promise<Response> => {
      subscriptions += 1;
      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      core.add({
        close: () => {
          writer.close().catch(() => undefined);
        },
        write: (chunk) => writer.write(encoder.encode(chunk)),
      });
      onSubscribe();
      return Promise.resolve(new Response(readable));
    },
  }),
  idFromName: (name: string) => name,
};

const env = {
  SESSION_STREAM:
    fakeNamespace as unknown as DurableObjectNamespace<SessionStream>,
};

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("composed", composed);
  await next();
});
app.route(
  "/api/sessions",
  sessionStreamRoutes({ session: () => currentSession })
);

const userIn = async (clerkOrgId: string, userId: string): Promise<User> => {
  const workspace: Workspace | null = await composed.services.workspaces.forOrg(
    { clerkOrgId }
  );
  if (!workspace) {
    throw new Error(`${clerkOrgId} must be allowed`);
  }
  return { kind: "user", userId, via: "session", workspaceId: workspace.id };
};

beforeEach(async () => {
  db = migrated(["org_a", "org_b"]);
  composed = composeWith({
    db,
    infra: infra(),
  });
  core = createStreamCore({ every: () => () => undefined });
  subscriptions = 0;
  onSubscribe = () => undefined;
  currentSession = { orgId: "org_a", userId: "user_a" };
  userA = await userIn("org_a", "user_a");
  agentId = (
    await composed.services.agents.create(userA, {
      model: "m",
      name: "Fake",
      runtime: "fake",
    })
  ).id;
});

/** A ui session of `owner`, with the events its run wrote. */
const sessionOf = async (owner: User, text: string): Promise<string> => {
  const { sessionId } = await composed.services.runs.startRun(owner, {
    agentId,
    input: { text },
    session: { origin: "ui" },
  });
  return sessionId;
};

/** Adds a user message to a session, the way a run's events land in it. */
const say = (sessionId: string, text: string): Promise<EventRecord> =>
  composed.services.events.append({
    actor: { id: userA.userId, kind: "user" },
    payload: { text },
    sessionId,
    type: "message.user",
    workspaceId: userA.workspaceId,
  });

/** Every stream event of a session, oldest first, as the replay would read it. */
const storedOf = (sessionId: string): Promise<EventRecord[]> =>
  composed.services.events.query(userA, userA.workspaceId, {
    limit: EVENT_QUERY_MAX_LIMIT,
    sessionId,
    types: [...STREAM_EVENT_TYPES],
  });

const open = (sessionId: string, headers: Record<string, string> = {}) =>
  app.request(`/api/sessions/${sessionId}/stream`, { headers }, env);

const ID_LINE = /^id: (.+)$/m;
const DATA_LINE = /^data: (.+)$/m;

const idOf = (block: string): string | undefined => ID_LINE.exec(block)?.[1];

const frameOf = (block: string): unknown => {
  const data = DATA_LINE.exec(block)?.[1];
  return data === undefined ? undefined : JSON.parse(data);
};

/** Reads SSE blocks from a body, a few at a time, keeping the rest for later. */
const blockReader = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queued: string[] = [];
  let text = "";
  const take = async (count: number): Promise<string[]> => {
    while (queued.length < count) {
      // biome-ignore lint/performance/noAwaitInLoops: one chunk at a time keeps the block order
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      const parts = text.split("\n\n");
      text = parts.pop() ?? "";
      queued.push(...parts);
    }
    return queued.splice(0, count);
  };
  return { cancel: () => reader.cancel(), take };
};

const bodyOf = (res: Response): ReadableStream<Uint8Array> => {
  if (!res.body) {
    throw new Error("expected a streamed body");
  }
  return res.body;
};

test("no Clerk session, or one without an active org, answers 401", async () => {
  const sessionId = await sessionOf(userA, "hi");

  currentSession = null;
  const signedOut = await open(sessionId);
  expect(signedOut.status).toBe(401);
  expect(await signedOut.json()).toEqual({ error: "Sign in required." });

  currentSession = { orgId: null, userId: "user_a" };
  const noOrg = await open(sessionId);
  expect(noOrg.status).toBe(401);
  expect(await noOrg.json()).toEqual({ error: "Sign in required." });

  expect(subscriptions).toBe(0);
});

test("another user's ui session and an unknown id both answer 404", async () => {
  const sessionId = await sessionOf(userA, "private");
  currentSession = { orgId: "org_b", userId: "user_b" };

  const hidden = await open(sessionId);
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toEqual({ error: "Not found." });

  const unknown = await open("01UNKNOWNSESSION");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "Not found." });

  expect(subscriptions).toBe(0);
});

test("Last-Event-ID replays the events after it in id order, then relays live frames", async () => {
  const sessionId = await sessionOf(userA, "first");
  await say(sessionId, "second");
  await say(sessionId, "third");
  const [first, ...rest] = await storedOf(sessionId);
  if (!first) {
    throw new Error("expected stored events");
  }
  expect(rest.length).toBeGreaterThan(0);

  const res = await open(sessionId, { "Last-Event-ID": first.id });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
  expect(res.headers.get("X-Accel-Buffering")).toBe("no");

  const sse = blockReader(bodyOf(res));
  const replayed = await sse.take(rest.length);
  expect(replayed.map(idOf)).toEqual(rest.map((record) => record.id));
  for (const [index, block] of replayed.entries()) {
    expect(block.startsWith(`id: ${rest[index]?.id}\ndata: `)).toBe(true);
    expect(frameOf(block)).toEqual(eventFrame(rest[index] as EventRecord));
  }

  const live = await say(sessionId, "live");
  const sent = core.publish(eventFrame(live));
  const [block] = await sse.take(1);
  await sent;
  expect(block).toBeDefined();
  expect(idOf(block ?? "")).toBe(live.id);
  expect(frameOf(block ?? "")).toEqual(eventFrame(live));

  await sse.cancel();
});

test("an event published between subscribe and the D1 read is sent once", async () => {
  const sessionId = await sessionOf(userA, "first");
  await say(sessionId, "second");
  const [first, ...rest] = await storedOf(sessionId);
  const [landed] = rest;
  if (!first) {
    throw new Error("expected stored events");
  }
  expect(landed).toBeDefined();

  // The event is already stored, and its live copy arrives after the subscribe.
  onSubscribe = () => {
    core.publish(eventFrame(landed as EventRecord)).catch(() => undefined);
  };
  const res = await open(sessionId, { "Last-Event-ID": first.id });
  onSubscribe = () => undefined;

  const live = await say(sessionId, "live");
  const sent = core.publish(eventFrame(live));
  const sse = blockReader(bodyOf(res));
  const blocks = await sse.take(rest.length + 1);
  await sent;

  expect(blocks.map(idOf)).toEqual([
    ...rest.map((record) => record.id),
    live.id,
  ]);
  await sse.cancel();
});

test("?after= resumes the same way as Last-Event-ID", async () => {
  const sessionId = await sessionOf(userA, "first");
  await say(sessionId, "second");
  const [first, ...rest] = await storedOf(sessionId);
  if (!first) {
    throw new Error("expected stored events");
  }

  const viaHeader = await open(sessionId, { "Last-Event-ID": first.id });
  const viaQuery = await app.request(
    `/api/sessions/${sessionId}/stream?after=${first.id}`,
    {},
    env
  );
  expect(viaQuery.status).toBe(200);

  const headerSse = blockReader(bodyOf(viaHeader));
  const querySse = blockReader(bodyOf(viaQuery));
  const expected = rest.map((record) => record.id);
  expect((await querySse.take(rest.length)).map(idOf)).toEqual(expected);
  expect((await headerSse.take(rest.length)).map(idOf)).toEqual(expected);
  await querySse.cancel();
  await headerSse.cancel();
});

test("without a resume point nothing is replayed, only live frames arrive", async () => {
  const sessionId = await sessionOf(userA, "first");
  await say(sessionId, "second");

  const res = await open(sessionId);
  expect(res.status).toBe(200);
  const sse = blockReader(bodyOf(res));

  const live = await say(sessionId, "live");
  const sent = core.publish(eventFrame(live));
  const [block] = await sse.take(1);
  await sent;
  expect(idOf(block ?? "")).toBe(live.id);
  await sse.cancel();
});

test("a resume point longer than an event id answers 400", async () => {
  const sessionId = await sessionOf(userA, "first");

  const res = await open(sessionId, { "Last-Event-ID": "x".repeat(201) });

  expect(res.status).toBe(400);
});

test("a relay whose keep check fails errors the stream and ends the live subscription", async () => {
  let cancelled = false;
  const live = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
    pull: (controller) => {
      controller.enqueue(
        new TextEncoder().encode('data: {"frame":"ping"}\n\n')
      );
    },
  });
  const reader = relay(NO_REPLAY, live, () =>
    Promise.reject(new Error("D1 is down"))
  ).getReader();

  await expect(reader.read()).rejects.toThrow("D1 is down");
  expect(cancelled).toBe(true);
});
