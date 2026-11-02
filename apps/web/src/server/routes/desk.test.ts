import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { migrated } from "@repo/db/test-db";
import type { MemberDirectory, NeedsYouItem } from "@repo/services/desk-api";
import { isServiceError } from "@repo/services/errors";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import type { SessionStream } from "../session-stream.ts";
import { createStreamCore, type StreamCore } from "../session-stream-core.ts";
import { deskRoutes } from "./desk.ts";
import type { AppEnv } from "./groups.ts";

const ROUTE = "/api/desk";
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
// A stand-in for the SessionStream namespace: one core per instance name, and
// each fetch subscribes to the named core the way the Durable Object does.
const cores = new Map<string, StreamCore>();
let subscriptions: string[] = [];
/** Runs after a stream subscribes and before its D1 read. */
let onSubscribe: () => Promise<void> | void = () => undefined;

const coreOf = (name: string): StreamCore => {
  let core = cores.get(name);
  if (!core) {
    core = createStreamCore({ every: () => () => undefined });
    cores.set(name, core);
  }
  return core;
};

const fakeNamespace = {
  get: (name: string) => ({
    fetch: async (): Promise<Response> => {
      subscriptions.push(name);
      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      coreOf(name).add({
        close: () => {
          writer.close().catch(() => undefined);
        },
        write: (chunk) => writer.write(encoder.encode(chunk)),
      });
      await onSubscribe();
      return new Response(readable);
    },
  }),
  idFromName: (name: string) => name,
};

const env = {
  RUN_TOKEN_KEY,
  SESSION_STREAM:
    fakeNamespace as unknown as DurableObjectNamespace<SessionStream>,
} as unknown as Env;
const MEMBER_EMAIL = "u2@example.com";
const DECISION = JSON.stringify({ decision: "allow_once" });

let db: ReturnType<typeof migrated>;
let composed: Composed;
let workspaceId: string;
let members: Set<string>;
let emails: Map<string, string>;
let directoryCalls: { clerkOrgId: string; email: string }[];
let deferred: Promise<unknown>[];
let logs: Record<string, unknown>[];
let app: Hono<AppEnv>;
let machineAgentId: string;
let machineId: string;

const sessionUser = (userId: string): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

const mintKey = async (access: "desk" | "read" | "write") =>
  (
    await composed.services.apiKeys.create(sessionUser("u1"), {
      access,
      name: `${access} key`,
    })
  ).secret;

interface CallOptions {
  body?: string;
  headers?: Record<string, string>;
  token?: string | null;
}

const send = (
  method: "GET" | "POST",
  path: string,
  { body, headers = {}, token = null }: CallOptions = {}
) =>
  app.request(
    `${ROUTE}${path}`,
    {
      body,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      method,
    },
    env
  );

const onBehalfOf = (email: string) => ({ "X-On-Behalf-Of": email });

/**
 * An approval waiting on a machine run that is claimed, so it is running.
 * The machine runtime queues the run with a relay that delivers nothing.
 */
const openApproval = async (toolUseId = "t1", agentId = machineAgentId) => {
  const started = await composed.services.runs.startRun(sessionUser("u2"), {
    agentId,
    input: { text: "work" },
    session: { origin: "ui" },
  });
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, started.runId);
  const record = await composed.services.requests.open(SYSTEM_PRINCIPAL, {
    input: { command: "ls" },
    kind: "approval",
    runId: started.runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId,
  });
  return { requestId: record.id, runId: started.runId };
};

const rowOf = (requestId: string) =>
  db.select().from(runRequests).where(eq(runRequests.id, requestId)).get();

beforeEach(async () => {
  db = migrated(["org_a"]);
  const store = new Map<string, string>();
  members = new Set(["u1@org_a", "u2@org_a"]);
  emails = new Map([
    [MEMBER_EMAIL, "u2"],
    ["u9@example.com", "u9"],
  ]);
  directoryCalls = [];
  deferred = [];
  logs = [];
  cores.clear();
  subscriptions = [];
  onSubscribe = () => undefined;
  const memberDirectory: MemberDirectory = (email, clerkOrgId) => {
    directoryCalls.push({ clerkOrgId, email });
    const userId = emails.get(email) ?? null;
    return Promise.resolve(
      userId !== null && members.has(`${userId}@${clerkOrgId}`) ? userId : null
    );
  };
  composed = composeWith({
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
      memberDirectory,
      relay: noopRelay,
      streams: {
        publish: (name, frame) => coreOf(name).publish(frame),
      },
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a has no workspace row");
  }
  workspaceId = workspace.id;
  const enrol = await composed.services.machines.createEnrollToken(
    sessionUser("u1"),
    { machineName: "laptop" }
  );
  const enrolled = await composed.services.machines.enroll({
    code: enrol.code,
    singleUser: false,
  });
  if (!enrolled) {
    throw new Error("enrol failed");
  }
  ({ machineId } = enrolled);
  machineAgentId = (
    await composed.services.agents.create(sessionUser("u1"), {
      machineId,
      model: "m",
      name: "Laptop box",
      runtime: "machine",
      slug: "laptop",
    })
  ).id;
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    ROUTE,
    deskRoutes({
      defer: (_c, work) => {
        deferred.push(work);
      },
      isOrgMember: () => (userId, clerkOrgId) =>
        Promise.resolve(members.has(`${userId}@${clerkOrgId}`)),
      log: (entry) => logs.push(entry),
    })
  );
});

describe("authentication", () => {
  const routes: { method: "GET" | "POST"; path: string }[] = [
    { method: "GET", path: "/needs-you" },
    { method: "GET", path: "/runs/run-1" },
    { method: "GET", path: "/stream" },
    { method: "POST", path: "/requests/req-1/decision" },
    { method: "POST", path: "/controller/messages" },
  ];

  test("a request without an Authorization header answers 401 with a bare challenge", async () => {
    const responses = await Promise.all(
      routes.map(({ method, path }) => send(method, path, { body: DECISION }))
    );
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        'Bearer realm="harbourmaster"'
      );
    }
  });

  test("an unknown hm_key_ token answers 401 with invalid_token", async () => {
    const responses = await Promise.all(
      routes.map(({ method, path }) =>
        send(method, path, {
          body: DECISION,
          headers: onBehalfOf(MEMBER_EMAIL),
          token: "hm_key_nope",
        })
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain(
        'error="invalid_token"'
      );
    }
  });
});

describe("scope and acting member", () => {
  test("a read key or a write key is refused with 403 on needs-you", async () => {
    const tokens = await Promise.all([mintKey("read"), mintKey("write")]);
    const responses = await Promise.all(
      tokens.map((token) =>
        send("GET", "/needs-you", {
          headers: onBehalfOf(MEMBER_EMAIL),
          token,
        })
      )
    );
    const bodies = await Promise.all(responses.map((res) => res.json()));
    for (const res of responses) {
      expect(res.status).toBe(403);
    }
    expect(bodies).toEqual([
      { error: "Not allowed." },
      { error: "Not allowed." },
    ]);
  });

  test("a desk key without X-On-Behalf-Of is refused with 403", async () => {
    const token = await mintKey("desk");
    const res = await send("GET", "/needs-you", { token });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not allowed." });
  });

  test("an email the directory does not know is refused with 403", async () => {
    const token = await mintKey("desk");
    const res = await send("GET", "/needs-you", {
      headers: onBehalfOf("nobody@example.com"),
      token,
    });
    expect(res.status).toBe(403);
    expect(directoryCalls).toContainEqual({
      clerkOrgId: "org_a",
      email: "nobody@example.com",
    });
  });

  test("an email known to the directory but not a member of org_a is refused with 403", async () => {
    members.delete("u9@org_a");
    const token = await mintKey("desk");
    const res = await send("GET", "/needs-you", {
      headers: onBehalfOf("u9@example.com"),
      token,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not allowed." });
  });
});

describe("GET /api/desk/needs-you", () => {
  test("answers an empty array when nothing is pending", async () => {
    const token = await mintKey("desk");
    const res = await send("GET", "/needs-you", {
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("lists an opened approval with exactly the C4 keys", async () => {
    const { requestId, runId } = await openApproval();
    const token = await mintKey("desk");

    const res = await send("GET", "/needs-you", {
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });

    expect(res.status).toBe(200);
    const items = (await res.json()) as NeedsYouItem[];
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "agent",
      "createdAt",
      "detail",
      "expiresAt",
      "kind",
      "requestId",
      "runId",
      "title",
    ]);
    expect(item).toMatchObject({
      agent: "Laptop box",
      kind: "approval",
      requestId,
      runId,
    });
    expect(directoryCalls).toContainEqual({
      clerkOrgId: "org_a",
      email: MEMBER_EMAIL,
    });
  });
});

describe("POST /api/desk/requests/:id/decision", () => {
  test("allow_once answers 200 and records the acting member, not the key's minter", async () => {
    const { requestId } = await openApproval();
    const token = await mintKey("desk");

    const res = await send("POST", `/requests/${requestId}/decision`, {
      body: DECISION,
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requestId, status: "answered" });
    expect(rowOf(requestId)).toMatchObject({
      answeredBy: "u2",
      answeredVia: "web",
      status: "answered",
    });
  });

  test("a second decision answers 409", async () => {
    const { requestId } = await openApproval();
    const token = await mintKey("desk");
    const headers = onBehalfOf(MEMBER_EMAIL);

    expect(
      (
        await send("POST", `/requests/${requestId}/decision`, {
          body: DECISION,
          headers,
          token,
        })
      ).status
    ).toBe(200);
    const again = await send("POST", `/requests/${requestId}/decision`, {
      body: DECISION,
      headers,
      token,
    });
    expect(again.status).toBe(409);
  });

  test("a bad body answers 400", async () => {
    const { requestId } = await openApproval();
    const token = await mintKey("desk");
    const headers = onBehalfOf(MEMBER_EMAIL);
    const bodies = [
      JSON.stringify({ decision: "maybe" }),
      "not json",
      JSON.stringify({ decision: "allow_once", extra: true }),
    ];

    const responses = await Promise.all(
      bodies.map((body) =>
        send("POST", `/requests/${requestId}/decision`, {
          body,
          headers,
          token,
        })
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(400);
    }
    expect(rowOf(requestId)?.status).toBe("pending");
  });

  test("an unknown id answers 404", async () => {
    const token = await mintKey("desk");
    const res = await send("POST", "/requests/req-nope/decision", {
      body: DECISION,
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Request not found" });
  });

  test("a route decision and a Slack answer at once leave exactly one winner", async () => {
    const { requestId } = await openApproval();
    const token = await mintKey("desk");

    const [routeResult, serviceResult] = await Promise.allSettled([
      send("POST", `/requests/${requestId}/decision`, {
        body: DECISION,
        headers: onBehalfOf(MEMBER_EMAIL),
        token,
      }),
      composed.services.requests.answer(sessionUser("u2"), {
        answer: { decision: "deny" },
        requestId,
        via: "slack",
      }),
    ]);

    const routeStatus =
      routeResult.status === "fulfilled" ? routeResult.value.status : null;
    const routeWon = routeStatus === 200;
    const serviceWon = serviceResult.status === "fulfilled";
    expect([routeWon, serviceWon].filter(Boolean)).toHaveLength(1);
    if (routeWon) {
      expect(serviceResult.status).toBe("rejected");
      expect(
        serviceResult.status === "rejected" &&
          isServiceError(serviceResult.reason)
          ? serviceResult.reason.code
          : null
      ).toBe("conflict");
    } else {
      expect(routeStatus).toBe(409);
    }
    expect(rowOf(requestId)).toMatchObject({
      answeredVia: routeWon ? "web" : "slack",
      status: "answered",
    });
  });
});

describe("POST /api/desk/controller/messages", () => {
  const message = (body: unknown, token: string, threadId?: string) =>
    send("POST", "/controller/messages", {
      body: JSON.stringify({
        ...(body as object),
        ...(threadId ? { threadId } : {}),
      }),
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });

  test("answers 404 when the workspace has no controller agent", async () => {
    const token = await mintKey("desk");
    const res = await message({ text: "hello" }, token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "This workspace has no controller agent",
    });
  });

  test("answers 200 with the run and session once a controller exists", async () => {
    await composed.services.agents.create(sessionUser("u1"), {
      model: "fake",
      name: "Controller",
      runtime: "fake",
      slug: "controller",
    });
    const token = await mintKey("desk");

    const res = await message({ text: "hello" }, token);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runId: expect.any(String),
      sessionId: expect.any(String),
    });
  });

  test("an empty text answers 400 and names the field", async () => {
    await composed.services.agents.create(sessionUser("u1"), {
      model: "fake",
      name: "Controller",
      runtime: "fake",
      slug: "controller",
    });
    const token = await mintKey("desk");

    const res = await message({ text: "" }, token);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.startsWith("text: ")).toBe(true);
  });

  test("the same threadId twice continues the same session", async () => {
    await composed.services.agents.create(sessionUser("u1"), {
      model: "fake",
      name: "Controller",
      runtime: "fake",
      slug: "controller",
    });
    const token = await mintKey("desk");

    const first = (await (
      await message({ text: "one" }, token, "thread-1")
    ).json()) as { sessionId: string };
    const second = (await (
      await message({ text: "two" }, token, "thread-1")
    ).json()) as { sessionId: string };

    expect(second.sessionId).toBe(first.sessionId);
  });
});

describe("GET /api/desk/runs/:runId", () => {
  const controller = () =>
    composed.services.agents.create(sessionUser("u1"), {
      model: "fake",
      name: "Controller",
      runtime: "fake",
      slug: "controller",
    });

  const readRun = (runId: string, token: string, email = MEMBER_EMAIL) =>
    send("GET", `/runs/${runId}`, { headers: onBehalfOf(email), token });

  const sendMessage = async (token: string) => {
    const res = await send("POST", "/controller/messages", {
      body: JSON.stringify({ text: "hello" }),
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });
    return (await res.json()) as { runId: string; sessionId: string };
  };

  test("answers 403 for an email that names no member", async () => {
    const token = await mintKey("desk");
    const res = await readRun("run-1", token, "nobody@example.com");
    expect(res.status).toBe(403);
  });

  test("answers 404 for an unknown run", async () => {
    const token = await mintKey("desk");
    const res = await readRun("no-such-run", token);
    expect(res.status).toBe(404);
  });

  test("answers 404 for another member's private run", async () => {
    const agent = await controller();
    const token = await mintKey("desk");
    const started = await composed.services.runs.startRun(sessionUser("u1"), {
      agentId: agent.id,
      input: { text: "private" },
      session: { origin: "ui" },
    });
    const res = await readRun(started.runId, token);
    expect(res.status).toBe(404);
  });

  test("reply is null while the run is not finished and set once it is", async () => {
    await controller();
    const token = await mintKey("desk");
    const { runId, sessionId } = await sendMessage(token);
    // The fake runtime answers at once, so put the run back to running.
    await db
      .update(runRows)
      .set({ resultText: null, status: "running" })
      .where(eq(runRows.id, runId));

    const pending = await readRun(runId, token);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      error: null,
      reply: null,
      runId,
      sessionId,
      status: "running",
    });

    await db
      .update(runRows)
      .set({ resultText: "All done.", status: "done" })
      .where(eq(runRows.id, runId));
    const done = await readRun(runId, token);
    expect(await done.json()).toEqual({
      error: null,
      reply: "All done.",
      runId,
      sessionId,
      status: "finished",
    });
  });

  test("a failed run carries its error and no reply", async () => {
    await controller();
    const token = await mintKey("desk");
    const { runId } = await sendMessage(token);
    await db
      .update(runRows)
      .set({ error: "It broke.", resultText: "partial", status: "failed" })
      .where(eq(runRows.id, runId));
    const res = await readRun(runId, token);
    expect(await res.json()).toMatchObject({
      error: "It broke.",
      reply: null,
      status: "failed",
    });
  });
});

describe("OAuth token", () => {
  test("a Clerk OAuth token is not a credential here: 401, and Clerk is never asked", async () => {
    const res = await send("GET", "/needs-you", { token: "oat_u2_client" });
    expect(res.status).toBe(401);
  });
});

describe("key use", () => {
  test("a successful call stamps the key's last_used_at", async () => {
    const token = await mintKey("desk");
    const res = await send("GET", "/needs-you", {
      headers: onBehalfOf(MEMBER_EMAIL),
      token,
    });
    expect(res.status).toBe(200);

    await Promise.all(deferred);
    const [key] = await composed.services.apiKeys.list(sessionUser("u1"));
    expect(key?.lastUsedAt).not.toBeNull();
  });
});

const DESK_TYPE = /^(request|run)\./;
const ID_LINE = /^id: (.+)$/m;
const DATA_LINE = /^data: (.+)$/m;

describe("GET /stream", () => {
  interface Seen {
    frame: string;
    id?: string;
    runId?: string;
    type?: string;
  }

  const seenOf = (block: string): Seen => {
    const data = JSON.parse(DATA_LINE.exec(block)?.[1] ?? "{}") as Seen;
    return { ...data, id: ID_LINE.exec(block)?.[1] };
  };

  const open = async (headers: Record<string, string> = {}) => {
    const token = await mintKey("desk");
    return send("GET", "/stream", {
      headers: { ...onBehalfOf(MEMBER_EMAIL), ...headers },
      token,
    });
  };

  /** Reads frames from the body until `done` says so, and cancels the stream. */
  const readUntil = async (
    res: Response,
    done: (seen: Seen) => boolean
  ): Promise<Seen[]> => {
    if (!res.body) {
      throw new Error("expected a streamed body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const frames: Seen[] = [];
    let text = "";
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: one chunk at a time keeps the frame order
      const chunk = await reader.read();
      if (chunk.done) {
        return frames;
      }
      text += decoder.decode(chunk.value, { stream: true });
      const blocks = text.split("\n\n");
      text = blocks.pop() ?? "";
      for (const block of blocks) {
        const seen = seenOf(block);
        frames.push(seen);
        if (done(seen)) {
          // biome-ignore lint/performance/noAwaitInLoops: the stream ends here
          await reader.cancel();
          return frames;
        }
      }
    }
  };

  /** An agent on the same machine, so a second run may be claimed while the first runs. */
  const anotherAgent = async (slug: string): Promise<string> =>
    (
      await composed.services.agents.create(sessionUser("u1"), {
        machineId,
        model: "m",
        name: slug,
        runtime: "machine",
        slug,
      })
    ).id;

  const opened = (runId: string) => (seen: Seen) =>
    seen.type === "request.opened" && seen.runId === runId;

  test("a read key or a desk key without a member is refused before any subscription", async () => {
    const read = await send("GET", "/stream", {
      headers: onBehalfOf(MEMBER_EMAIL),
      token: await mintKey("read"),
    });
    const noMember = await send("GET", "/stream", {
      token: await mintKey("desk"),
    });
    expect(read.status).toBe(403);
    expect(noMember.status).toBe(403);
    expect(subscriptions).toEqual([]);
  });

  test("a resume point over the id length is a 400", async () => {
    const res = await open({ "Last-Event-ID": "x".repeat(201) });
    expect(res.status).toBe(400);
    expect(subscriptions).toEqual([]);
  });

  test("it streams a new request of the member as it opens, on the workspace's desk instance", async () => {
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(subscriptions).toEqual([`desk:${workspaceId}`]);

    const request = await openApproval();
    const frames = await readUntil(res, opened(request.runId));

    expect(frames.at(-1)).toMatchObject({
      frame: "event",
      runId: request.runId,
      type: "request.opened",
    });
    // Run status frames ride along, and only request.* and run.* events do.
    expect(frames.some((seen) => seen.frame === "run")).toBe(true);
    for (const seen of frames.filter(({ frame }) => frame === "event")) {
      expect(seen.type).toMatch(DESK_TYPE);
    }
    await Promise.all(deferred);
    const [key] = await composed.services.apiKeys.list(sessionUser("u1"));
    expect(key?.lastUsedAt).not.toBeNull();
  });

  test("another member's ui session never reaches the stream", async () => {
    const res = await open();
    const theirs = await composed.services.runs.startRun(sessionUser("u1"), {
      agentId: await anotherAgent("theirs-box"),
      input: { text: "private" },
      session: { origin: "ui" },
    });
    const mine = await openApproval();

    const frames = await readUntil(res, opened(mine.runId));

    expect(frames.length).toBeGreaterThan(0);
    for (const seen of frames) {
      expect(seen.runId).not.toBe(theirs.runId);
    }
  });

  test("a resumed stream replays what came after Last-Event-ID, once, and skips what the member may not see", async () => {
    const first = await open();
    const before = await openApproval("t1");
    const earlier = await readUntil(first, opened(before.runId));
    const lastId = earlier.findLast((seen) => seen.id)?.id;
    if (!lastId) {
      throw new Error("the first stream sent no event");
    }

    const theirs = await composed.services.runs.startRun(sessionUser("u1"), {
      agentId: machineAgentId,
      input: { text: "private" },
      session: { origin: "ui" },
    });
    // The request opens after the subscription and before the replay read, so
    // it is in the live stream and in D1.
    let late: { requestId: string; runId: string } | undefined;
    const lateAgent = await anotherAgent("late-box");
    onSubscribe = async () => {
      late = await openApproval("t2", lateAgent);
    };

    const resumed = await open({ "Last-Event-ID": lastId });
    onSubscribe = () => undefined;
    // The live copy of the late request is already queued. Reading on to a
    // request opened after it shows the stream sends the late one only once.
    const sentinel = await openApproval("t3", await anotherAgent("end-box"));
    const frames = await readUntil(resumed, opened(sentinel.runId));

    const ids = frames.flatMap((seen) => (seen.id ? [seen.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of earlier.flatMap((seen) => (seen.id ? [seen.id] : []))) {
      expect(ids).not.toContain(id);
    }
    expect(frames.some((seen) => seen.runId === theirs.runId)).toBe(false);
    expect(
      frames.filter(
        (seen) => seen.type === "request.opened" && seen.runId === late?.runId
      )
    ).toHaveLength(1);
  });
});
