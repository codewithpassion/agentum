import { beforeEach, describe, expect, test } from "bun:test";
import { agentCardSchema } from "@repo/a2a/agent-card";
import { PAIRING_EXTENSION_URI } from "@repo/a2a/extensions";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type A2aFixture,
  createA2aFixture,
  INSTRUCTIONS,
  ORIGIN,
  textMessage,
} from "./a2a-fixture.ts";

const ACCESS_PREFIX = "hm_a2a_";
const WWW_AUTHENTICATE = 'Bearer realm="agentum"';
const CARD_PATH = "/.well-known/agent-card.json";
const MAX_AGE = /max-age=\d+/;
const WHOLE_NUMBER = /^\d+$/;

let f: A2aFixture;

beforeEach(async () => {
  f = await createA2aFixture({
    timing: { blockMs: 20, pollMs: 5, streamMs: 50 },
  });
});

const readJson = (res: Response): Promise<unknown> => res.json();

const getCard = (publicId: string) =>
  f.app.request(`${ORIGIN}/a2a/${publicId}${CARD_PATH}`);

/** True when `key` is a property name anywhere in the value. */
const hasKeyDeep = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([name, child]) => name === key || hasKeyDeep(child, key)
    );
  }
  return false;
};

// ---------------------------------------------------------------------------
// The card

describe("agent card", () => {
  test("the card parses and lists both bindings, streaming, push and the pairing extension", async () => {
    const agent = await f.publish("card");
    const res = await getCard(agent.publicId);
    expect(res.status).toBe(200);
    const card = agentCardSchema.parse(await readJson(res));
    const base = `${ORIGIN}/a2a/${agent.publicId}`;
    expect(card.supportedInterfaces).toEqual([
      {
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        url: `${base}/rpc`,
      },
      {
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        url: `${base}/rest`,
      },
    ]);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.capabilities.extendedAgentCard).toBe(false);
    expect(card.securitySchemes).toHaveProperty("bearer");
    expect(card.capabilities.extensions).toContainEqual(
      expect.objectContaining({ required: false, uri: PAIRING_EXTENSION_URI })
    );
  });

  test("the card answers with Cache-Control and an ETag, and a matching If-None-Match gets a 304 with no body", async () => {
    const agent = await f.publish("cached");
    const first = await getCard(agent.publicId);
    const etag = first.headers.get("ETag");
    expect(first.headers.get("Cache-Control")).toMatch(MAX_AGE);
    expect(etag).not.toBeNull();
    await first.text();

    const again = await f.app.request(
      `${ORIGIN}/a2a/${agent.publicId}${CARD_PATH}`,
      { headers: { "If-None-Match": etag ?? "" } }
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  test("an unknown publicId answers 404", async () => {
    const res = await getCard("no-such-agent");
    expect(res.status).toBe(404);
  });

  test("an unpublished card answers 404", async () => {
    const agent = await f.publish("unpublished");
    await f.composed.services.connections.unpublish(f.admin, agent.agentId);
    const res = await getCard(agent.publicId);
    expect(res.status).toBe(404);
  });

  test("the card holds no instructions key anywhere", async () => {
    const agent = await f.publish("no-instructions");
    const res = await getCard(agent.publicId);
    const text = await res.text();
    expect(text).not.toContain(INSTRUCTIONS);
    expect(hasKeyDeep(JSON.parse(text), "instructions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authentication and the other checks, on both bindings

interface BindingCase {
  contentType: string;
  /** GetTask on a task id, with extra headers. */
  getTask: (
    publicId: string,
    token: string | null,
    taskId: string,
    extra?: Record<string, string>
  ) => Promise<Response>;
  /** A POST with a body that is not JSON and no credential. */
  malformedNoToken: (publicId: string) => Promise<Response>;
  name: string;
  /** The body of the hourly limit. */
  rateLimitedBody: object;
  /** A GetTask request built by hand, so a header can be left out. */
  rawGetTask: (
    publicId: string,
    headers: Record<string, string>,
    taskId: string
  ) => Promise<Response>;
  /** A message on an existing task, which answers the question it asks. */
  sendAnswer: (
    publicId: string,
    token: string,
    messageId: string,
    taskId: string
  ) => Promise<Response>;
  /** SendMessage with a message id, under a valid token. */
  sendMessage: (
    publicId: string,
    token: string,
    messageId: string
  ) => Promise<Response>;
  /** The task id in a SendMessage answer. */
  taskIdOf: (body: unknown) => string;
  /** The 401 body, as sent. */
  unauthorizedBody: object;
  /** The body of a refused version. */
  versionBody: object;
  /** The status of a refused version. */
  versionStatus: number;
}

const answerMessage = (messageId: string, taskId: string) => ({
  message: {
    messageId,
    parts: [{ text: "Yes" }],
    role: "ROLE_USER",
    taskId,
  },
});

const BINDINGS: BindingCase[] = [
  {
    contentType: "application/json",
    getTask: async (publicId, token, taskId, extra) =>
      await f.rpc(publicId, token, "GetTask", { id: taskId }, extra),
    malformedNoToken: async (publicId) =>
      await f.app.request(`/a2a/${publicId}/rpc`, {
        body: "{not json",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    name: "JSON-RPC",
    rateLimitedBody: { error: { code: -32_000 } },
    rawGetTask: async (publicId, headers, taskId) =>
      await f.app.request(`/a2a/${publicId}/rpc`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "GetTask",
          params: { id: taskId },
        }),
        headers: { "Content-Type": "application/json", ...headers },
        method: "POST",
      }),
    sendAnswer: async (publicId, token, messageId, taskId) =>
      await f.rpc(
        publicId,
        token,
        "SendMessage",
        answerMessage(messageId, taskId)
      ),
    sendMessage: async (publicId, token, messageId) =>
      await f.rpc(publicId, token, "SendMessage", textMessage(messageId, "Hi")),
    taskIdOf: (body) =>
      z
        .object({ result: z.object({ task: z.object({ id: z.string() }) }) })
        .parse(body).result.task.id,
    unauthorizedBody: {
      error: { code: -32_000, message: "Authentication is required." },
      id: null,
      jsonrpc: "2.0",
    },
    versionBody: {
      error: {
        code: -32_009,
        data: [{ domain: "a2a-protocol.org", reason: "VERSION_NOT_SUPPORTED" }],
      },
    },
    versionStatus: 200,
  },
  {
    contentType: "application/json",
    getTask: async (publicId, token, taskId, extra) =>
      await f.rest(
        publicId,
        token,
        "GET",
        `/tasks/${taskId}`,
        undefined,
        extra
      ),
    malformedNoToken: async (publicId) =>
      await f.app.request(`/a2a/${publicId}/rest/message:send`, {
        body: "{not json",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    name: "HTTP+JSON",
    rateLimitedBody: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
    rawGetTask: async (publicId, headers, taskId) =>
      await f.app.request(`/a2a/${publicId}/rest/tasks/${taskId}`, {
        headers,
        method: "GET",
      }),
    sendAnswer: async (publicId, token, messageId, taskId) =>
      await f.rest(
        publicId,
        token,
        "POST",
        "/message:send",
        answerMessage(messageId, taskId)
      ),
    sendMessage: async (publicId, token, messageId) =>
      await f.rest(
        publicId,
        token,
        "POST",
        "/message:send",
        textMessage(messageId, "Hi")
      ),
    taskIdOf: (body) =>
      z.object({ task: z.object({ id: z.string() }) }).parse(body).task.id,
    unauthorizedBody: {
      error: {
        code: 401,
        details: [],
        message: "Authentication is required.",
        status: "UNAUTHENTICATED",
      },
    },
    versionBody: {
      error: {
        code: 400,
        details: [{ reason: "VERSION_NOT_SUPPORTED" }],
        status: "UNIMPLEMENTED",
      },
    },
    versionStatus: 400,
  },
];

const CAUSES = [
  "no token",
  "wrong token",
  "token without the prefix",
  "revoked connection",
  "another agent's publicId",
] as const;
type Cause = (typeof CAUSES)[number];

/**
 * Makes the agent and connection a cause needs, then makes the GetTask call
 * with the credential that cause leaves. `tag` keeps the slugs apart when one
 * test runs several causes on the same fixture.
 */
const refusedBy = async (
  binding: BindingCase,
  cause: Cause,
  tag: string
): Promise<Response> => {
  const agent = await f.publish(`agent-${tag}`);
  const { connectionId, token } = await f.connect(agent);
  const taskId = await f.seedTask(connectionId, "TASK_STATE_WORKING");
  switch (cause) {
    case "no token":
      return await binding.getTask(agent.publicId, null, taskId);
    case "wrong token":
      return await binding.getTask(
        agent.publicId,
        `${ACCESS_PREFIX}not-a-real-key`,
        taskId
      );
    case "token without the prefix":
      if (!token.startsWith(ACCESS_PREFIX)) {
        throw new Error("The access key has no hm_a2a_ prefix to strip.");
      }
      return await binding.getTask(
        agent.publicId,
        token.slice(ACCESS_PREFIX.length),
        taskId
      );
    case "revoked connection": {
      const first = await binding.getTask(agent.publicId, token, taskId);
      if (first.status !== 200) {
        throw new Error(
          `The connection failed before its revoke: ${first.status}`
        );
      }
      await f.composed.services.connections.revoke(f.member, connectionId);
      return await binding.getTask(agent.publicId, token, taskId);
    }
    case "another agent's publicId": {
      const other = await f.publish(`other-${tag}`);
      return await binding.getTask(other.publicId, token, taskId);
    }
    default:
      throw new Error(`Unknown cause: ${cause}`);
  }
};

/** What a refused response looks like, for comparing refusals. */
const refusalOf = async (res: Response) => ({
  body: await readJson(res),
  contentType: res.headers.get("Content-Type"),
  status: res.status,
  wwwAuthenticate: res.headers.get("WWW-Authenticate"),
});

const expectedRefusal = (binding: BindingCase) => ({
  body: binding.unauthorizedBody,
  contentType: binding.contentType,
  status: 401,
  wwwAuthenticate: WWW_AUTHENTICATE,
});

for (const binding of BINDINGS) {
  describe(`authentication on ${binding.name}`, () => {
    for (const cause of CAUSES) {
      test(`${cause} answers 401 with the same header and body`, async () => {
        const res = await refusedBy(
          binding,
          cause,
          `solo-${CAUSES.indexOf(cause)}`
        );
        expect(await refusalOf(res)).toEqual(expectedRefusal(binding));
      });
    }

    test("all the refusals have the same status, header and body", async () => {
      const responses = await Promise.all(
        CAUSES.map((cause, index) => refusedBy(binding, cause, `same-${index}`))
      );
      const seen = await Promise.all(responses.map(refusalOf));
      for (const each of seen) {
        expect(each).toEqual(expectedRefusal(binding));
      }
    });

    test("the 401 comes before the body is read", async () => {
      const agent = await f.publish("unread");
      const res = await binding.malformedNoToken(agent.publicId);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(WWW_AUTHENTICATE);
    });
  });
}

// ---------------------------------------------------------------------------
// The A2A-Version header, on both bindings

for (const binding of BINDINGS) {
  describe(`A2A-Version on ${binding.name}`, () => {
    test("a missing A2A-Version answers VersionNotSupportedError", async () => {
      const agent = await f.publish("no-version");
      const { connectionId, token } = await f.connect(agent);
      const taskId = await f.seedTask(connectionId, "TASK_STATE_WORKING");
      const res = await binding.rawGetTask(
        agent.publicId,
        { Authorization: `Bearer ${token}` },
        taskId
      );
      expect(res.status).toBe(binding.versionStatus);
      expect(await readJson(res)).toMatchObject(binding.versionBody);
    });

    test("a wrong A2A-Version (0.3) answers VersionNotSupportedError", async () => {
      const agent = await f.publish("old-version");
      const { connectionId, token } = await f.connect(agent);
      const taskId = await f.seedTask(connectionId, "TASK_STATE_WORKING");
      const res = await binding.getTask(agent.publicId, token, taskId, {
        "A2A-Version": "0.3",
      });
      expect(res.status).toBe(binding.versionStatus);
      expect(await readJson(res)).toMatchObject(binding.versionBody);
    });

    test("a correct call carries the A2A-Version: 1.0 response header", async () => {
      const agent = await f.publish("right-version");
      const { connectionId, token } = await f.connect(agent);
      const taskId = await f.seedTask(connectionId, "TASK_STATE_WORKING");
      const res = await binding.getTask(agent.publicId, token, taskId);
      expect(res.status).toBe(200);
      expect(res.headers.get("A2A-Version")).toBe("1.0");
    });
  });
}

// ---------------------------------------------------------------------------
// The hourly limit, on both bindings

for (const binding of BINDINGS) {
  describe(`hourly limit on ${binding.name}`, () => {
    test("the second message in the hour answers 429 with Retry-After, and a retry of the first still answers its task", async () => {
      const agent = await f.publish("limited");
      const { connectionId, token } = await f.connect(agent, "auto");
      await f.composed.services.connections.setPolicies(f.admin, {
        connectionId,
        hourlyLimit: 1,
      });

      const first = await binding.sendMessage(agent.publicId, token, "m1");
      expect(first.status).toBe(200);
      const taskId = binding.taskIdOf(await readJson(first));

      const second = await binding.sendMessage(agent.publicId, token, "m2");
      expect(second.status).toBe(429);
      const retryAfter = second.headers.get("Retry-After") ?? "";
      expect(retryAfter).toMatch(WHOLE_NUMBER);
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      expect(await readJson(second)).toMatchObject(binding.rateLimitedBody);

      const retry = await binding.sendMessage(agent.publicId, token, "m1");
      expect(retry.status).toBe(200);
      expect(binding.taskIdOf(await readJson(retry))).toBe(taskId);
    });

    test("an answer past the limit answers 429 with Retry-After and leaves the question open", async () => {
      const agent = await f.publish("limited-answers");
      const { connectionId, token } = await f.connect(agent, "auto");
      await f.composed.services.connections.setPolicies(f.admin, {
        connectionId,
        hourlyLimit: 2,
      });
      const first = await binding.sendMessage(agent.publicId, token, "m1");
      const taskId = binding.taskIdOf(await readJson(first));
      // The fake runtime finished the run at once. Put it back to waiting on two questions.
      f.db.run(
        sql`update runs set status = 'waiting', finished_at = null where id = (select run_id from a2a_tasks where id = ${taskId})`
      );
      f.db.run(
        sql`update a2a_tasks set state = 'TASK_STATE_WORKING', result_text = null where id = ${taskId}`
      );
      const runId =
        f.db.all<{ runId: string }>(
          sql`select run_id as runId from a2a_tasks where id = ${taskId}`
        )[0]?.runId ?? "";
      for (const toolUseId of ["q1", "q2"]) {
        // biome-ignore lint/performance/noAwaitInLoops: questions open in order
        await f.composed.services.requests.open(SYSTEM_PRINCIPAL, {
          kind: "question",
          questions: [{ question: `Question ${toolUseId}?` }],
          runId,
          toolName: "AskUserQuestion",
          toolUseId,
        });
      }

      const answered = await binding.sendAnswer(
        agent.publicId,
        token,
        "m2",
        taskId
      );
      expect(answered.status).toBe(200);

      const refused = await binding.sendAnswer(
        agent.publicId,
        token,
        "m3",
        taskId
      );
      expect(refused.status).toBe(429);
      expect(refused.headers.get("Retry-After") ?? "").toMatch(WHOLE_NUMBER);
      expect(await readJson(refused)).toMatchObject(binding.rateLimitedBody);
      const open = f.db.all<{ open: number }>(
        sql`select count(*) as open from run_requests where run_id = ${runId} and status = 'pending'`
      )[0]?.open;
      expect(open).toBe(1);

      const retry = await binding.sendAnswer(
        agent.publicId,
        token,
        "m2",
        taskId
      );
      expect(retry.status).toBe(200);
    });
  });
}
