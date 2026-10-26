import { beforeEach, describe, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runRequests } from "@repo/db/schema/requests";
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
import { deskRoutes } from "./desk.ts";
import type { AppEnv } from "./groups.ts";

const ROUTE = "/api/desk";
const RUN_TOKEN_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString(
  "base64"
);
const env = {
  ALLOWED_ORG_IDS: "org_a",
  RUN_TOKEN_KEY,
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
const openApproval = async (toolUseId = "t1") => {
  const started = await composed.services.runs.startRun(sessionUser("u2"), {
    agentId: machineAgentId,
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
  db = migrated();
  const store = new Map<string, string>();
  members = new Set(["u1@org_a", "u2@org_a"]);
  emails = new Map([
    [MEMBER_EMAIL, "u2"],
    ["u9@example.com", "u9"],
  ]);
  directoryCalls = [];
  deferred = [];
  logs = [];
  const memberDirectory: MemberDirectory = (email, clerkOrgId) => {
    directoryCalls.push({ clerkOrgId, email });
    const userId = emails.get(email) ?? null;
    return Promise.resolve(
      userId !== null && members.has(`${userId}@${clerkOrgId}`) ? userId : null
    );
  };
  composed = composeWith({
    allowedOrgIds: ["org_a"],
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
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: "org_a",
  });
  if (!workspace) {
    throw new Error("org_a is not an allowed organisation");
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
  machineAgentId = (
    await composed.services.agents.create(sessionUser("u1"), {
      machineId: enrolled.machineId,
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
