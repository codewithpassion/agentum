// The non-streaming A2A operations, each run on the JSON-RPC and the HTTP+JSON
// binding. Both bindings call `runOperation`, so a test here asserts that the
// outcome a client gets is the same on either binding.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  type A2aFixture,
  createA2aFixture,
  type Published,
  textMessage,
} from "./a2a-fixture.ts";

const JSON_TYPE = "application/json";
const A2A_TYPE = "application/a2a+json";
const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const ERROR_DOMAIN = "a2a-protocol.org";

/** The keys whose values differ between two tasks, replaced by their name. */
const PLACEHOLDER_KEYS = new Set([
  "artifactId",
  "contextId",
  "id",
  "messageId",
  "taskId",
  "timestamp",
]);

/**
 * A copy of `value` with ids and timestamps replaced by placeholders, so two
 * results from two different tasks compare equal. A connection id inside a
 * string (such as artifact text) is replaced too.
 */
const normalize = (
  value: unknown,
  connectionIds: readonly string[] = []
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, connectionIds));
  }
  if (typeof value === "string") {
    return connectionIds.reduce(
      (text, id) => text.replaceAll(id, "<connection>"),
      value
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        PLACEHOLDER_KEYS.has(key) && typeof item === "string"
          ? `<${key}>`
          : normalize(item, connectionIds),
      ])
    );
  }
  return value;
};

/** The value at a path in a parsed body, or undefined. */
const field = (value: unknown, ...path: (number | string)[]): unknown =>
  path.reduce<unknown>((node, key) => {
    if (typeof key === "number") {
      return Array.isArray(node) ? node[key] : undefined;
    }
    return typeof node === "object" && node !== null
      ? (node as Record<string, unknown>)[key]
      : undefined;
  }, value);

/** The text of a task's first artifact. The fake runtime echoes the run input, wrapped in a turn envelope. */
const artifactText = (task: unknown): unknown =>
  field(task, "artifacts", 0, "parts", 0, "text");

interface Reply {
  body: unknown;
  headers: Headers;
  status: number;
}

const reply = async (response: Response): Promise<Reply> => ({
  body: await response.json(),
  headers: response.headers,
  status: response.status,
});

/** The id of the task in a JSON-RPC SendMessage or CancelTask reply. */
const taskIdOf = (value: Reply): string =>
  String(field(value.body, "result", "task", "id"));

/** What a JSON-RPC error reply holds, for one assertion. */
const rpcFailure = (value: Reply) => ({
  code: field(value.body, "error", "code"),
  contentType: value.headers.get("Content-Type"),
  data: field(value.body, "error", "data"),
  httpStatus: value.status,
});

/** What an HTTP+JSON error reply holds, for one assertion. */
const restFailure = (value: Reply) => ({
  code: field(value.body, "error", "code"),
  contentType: value.headers.get("Content-Type"),
  details: field(value.body, "error", "details"),
  httpStatus: value.status,
  status: field(value.body, "error", "status"),
});

/** The `google.rpc.ErrorInfo` an A2A specific error carries. */
const errorInfo = (reason: string) => ({
  "@type": ERROR_INFO_TYPE,
  domain: ERROR_DOMAIN,
  reason,
});

const SECRET_MARKERS = ['"token"', '"credentials"', '"t"'];

/** The secret markers a reply repeats. Push config replies never carry a token or credentials. */
const leakedSecrets = (value: Reply): string[] => {
  const text = JSON.stringify(value.body);
  return SECRET_MARKERS.filter((marker) => text.includes(marker));
};

let f: A2aFixture;
let agent: Published;

beforeEach(async () => {
  f = await createA2aFixture({
    timing: { blockMs: 50, pollMs: 5, streamMs: 100 },
  });
  agent = await f.publish("echo");
});

const rpcCall = async (
  token: string | null,
  method: string,
  params?: unknown
): Promise<Reply> => reply(await f.rpc(agent.publicId, token, method, params));

const restCall = async (
  token: string | null,
  verb: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Reply> =>
  reply(await f.rest(agent.publicId, token, verb, path, body));

/** A raw POST to the agent, for a body the fixture would not send as JSON. */
const rawPost = (path: string, token: string, body: string) =>
  f.app.request(`/a2a/${agent.publicId}${path}`, {
    body,
    headers: {
      "A2A-Version": "1.0",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

describe("SendMessage", () => {
  test("completes with the same task on both bindings", async () => {
    const first = await f.connect(agent, "auto", "Hermes");
    const second = await f.connect(agent, "auto", "Hermes");
    const viaRpc = await rpcCall(
      first.token,
      "SendMessage",
      textMessage("m-rpc", "hi")
    );
    const viaRest = await restCall(
      second.token,
      "POST",
      "/message:send",
      textMessage("m-rest", "hi")
    );

    expect(viaRpc.status).toBe(200);
    expect(viaRest.status).toBe(200);
    const rpcTask = field(viaRpc.body, "result", "task");
    const restTask = field(viaRest.body, "task");
    expect(field(rpcTask, "status", "state")).toBe("TASK_STATE_COMPLETED");
    expect(field(restTask, "status", "state")).toBe("TASK_STATE_COMPLETED");
    expect(artifactText(rpcTask)).toContain('"text":"hi"');
    expect(
      normalize(rpcTask, [first.connectionId, second.connectionId])
    ).toEqual(normalize(restTask, [first.connectionId, second.connectionId]));
  });

  test("accepts a Hermes text part with a mediaType on both bindings", async () => {
    const connection = await f.connect(agent, "auto", "Hermes");
    const message = {
      message: {
        messageId: "m-hermes",
        parts: [{ mediaType: "text/plain", text: "hello" }],
        role: "ROLE_USER",
      },
    };
    const viaRpc = await rpcCall(connection.token, "SendMessage", message);
    const viaRest = await restCall(connection.token, "POST", "/message:send", {
      message: { ...message.message, messageId: "m-hermes-rest" },
    });

    expect(field(viaRpc.body, "result", "task", "status", "state")).toBe(
      "TASK_STATE_COMPLETED"
    );
    expect(field(viaRest.body, "task", "status", "state")).toBe(
      "TASK_STATE_COMPLETED"
    );
    expect(artifactText(field(viaRpc.body, "result", "task"))).toContain(
      '"text":"hello"'
    );
    expect(
      normalize(field(viaRpc.body, "result", "task"), [connection.connectionId])
    ).toEqual(
      normalize(field(viaRest.body, "task"), [connection.connectionId])
    );
  });

  test("returnImmediately gives AUTH_REQUIRED at once on both bindings", async () => {
    const first = await f.connect(agent, "approve", "A");
    const second = await f.connect(agent, "approve", "A");
    const configuration = { returnImmediately: true };
    const viaRpc = await rpcCall(first.token, "SendMessage", {
      ...textMessage("m-rpc", "hi"),
      configuration,
    });
    const viaRest = await restCall(second.token, "POST", "/message:send", {
      ...textMessage("m-rest", "hi"),
      configuration,
    });

    const rpcTask = field(viaRpc.body, "result", "task");
    const restTask = field(viaRest.body, "task");
    expect(field(rpcTask, "status", "state")).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(field(restTask, "status", "state")).toBe("TASK_STATE_AUTH_REQUIRED");
    expect(field(rpcTask, "status", "message", "parts", 0, "text")).toContain(
      "Waiting for a person"
    );
    expect(field(restTask, "status", "message", "parts", 0, "text")).toContain(
      "Waiting for a person"
    );
    expect(
      normalize(rpcTask, [first.connectionId, second.connectionId])
    ).toEqual(normalize(restTask, [first.connectionId, second.connectionId]));
  });
});

describe("GetTask", () => {
  test("reads the same task on both bindings", async () => {
    const connection = await f.connect(agent);
    const sent = await rpcCall(
      connection.token,
      "SendMessage",
      textMessage("m1", "hi")
    );
    const id = taskIdOf(sent);

    const viaRpc = await rpcCall(connection.token, "GetTask", { id });
    const viaRest = await restCall(connection.token, "GET", `/tasks/${id}`);

    expect(field(viaRpc.body, "result", "id")).toBe(id);
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });

  test("historyLength 0 leaves no history on both bindings", async () => {
    const connection = await f.connect(agent);
    const sent = await rpcCall(
      connection.token,
      "SendMessage",
      textMessage("m1", "hi")
    );
    const id = taskIdOf(sent);

    const viaRpc = await rpcCall(connection.token, "GetTask", {
      historyLength: 0,
      id,
    });
    const viaRest = await restCall(
      connection.token,
      "GET",
      `/tasks/${id}?historyLength=0`
    );

    expect(field(viaRpc.body, "result", "history")).toBeUndefined();
    expect(field(viaRest.body, "history")).toBeUndefined();
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });
});

describe("ListTasks", () => {
  test("pages the same way on both bindings", async () => {
    const connection = await f.connect(agent);
    await rpcCall(connection.token, "SendMessage", textMessage("m1", "one"));
    await rpcCall(connection.token, "SendMessage", textMessage("m2", "two"));

    const viaRpc = await rpcCall(connection.token, "ListTasks", {
      pageSize: 1,
    });
    const viaRest = await restCall(
      connection.token,
      "GET",
      "/tasks?pageSize=1"
    );

    expect(field(viaRpc.body, "result", "tasks")).toHaveLength(1);
    expect(field(viaRpc.body, "result", "nextPageToken")).not.toBe("");
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });

  test("filters by status on both bindings", async () => {
    const connection = await f.connect(agent);
    await rpcCall(connection.token, "SendMessage", textMessage("m1", "one"));
    await rpcCall(connection.token, "SendMessage", textMessage("m2", "two"));
    await f.seedTask(connection.connectionId, "TASK_STATE_WORKING");

    const viaRpc = await rpcCall(connection.token, "ListTasks", {
      status: "TASK_STATE_COMPLETED",
    });
    const viaRest = await restCall(
      connection.token,
      "GET",
      "/tasks?status=TASK_STATE_COMPLETED"
    );

    expect(field(viaRpc.body, "result", "tasks")).toHaveLength(2);
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });

  test("filters by contextId on both bindings", async () => {
    const connection = await f.connect(agent);
    await rpcCall(connection.token, "SendMessage", textMessage("m1", "one"));
    await rpcCall(
      connection.token,
      "SendMessage",
      textMessage("m2", "two", "ctx-shared")
    );

    const viaRpc = await rpcCall(connection.token, "ListTasks", {
      contextId: "ctx-shared",
    });
    const viaRest = await restCall(
      connection.token,
      "GET",
      "/tasks?contextId=ctx-shared"
    );

    expect(field(viaRpc.body, "result", "tasks")).toHaveLength(1);
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });

  test("includeArtifacts=true on REST equals includeArtifacts on JSON-RPC", async () => {
    const connection = await f.connect(agent);
    await rpcCall(connection.token, "SendMessage", textMessage("m1", "one"));

    const viaRpc = await rpcCall(connection.token, "ListTasks", {
      includeArtifacts: true,
    });
    const viaRest = await restCall(
      connection.token,
      "GET",
      "/tasks?includeArtifacts=true"
    );

    expect(field(viaRpc.body, "result", "tasks", 0, "artifacts")).toHaveLength(
      1
    );
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });
});

describe("CancelTask", () => {
  test("cancels a task waiting in AUTH_REQUIRED on both bindings", async () => {
    const connection = await f.connect(agent, "approve");
    const one = await rpcCall(
      connection.token,
      "SendMessage",
      textMessage("m1", "one")
    );
    const two = await rpcCall(
      connection.token,
      "SendMessage",
      textMessage("m2", "one")
    );
    expect(field(one.body, "result", "task", "status", "state")).toBe(
      "TASK_STATE_AUTH_REQUIRED"
    );

    const viaRpc = await rpcCall(connection.token, "CancelTask", {
      id: taskIdOf(one),
    });
    const viaRest = await restCall(
      connection.token,
      "POST",
      `/tasks/${taskIdOf(two)}:cancel`,
      {}
    );

    expect(field(viaRpc.body, "result", "status", "state")).toBe(
      "TASK_STATE_CANCELED"
    );
    expect(field(viaRest.body, "status", "state")).toBe("TASK_STATE_CANCELED");
    expect(
      normalize(field(viaRpc.body, "result"), [connection.connectionId])
    ).toEqual(normalize(viaRest.body, [connection.connectionId]));
  });

  test("refuses to cancel a finished task with TaskNotCancelableError on both bindings", async () => {
    const connection = await f.connect(agent, "auto");
    const sent = await rpcCall(
      connection.token,
      "SendMessage",
      textMessage("m1", "one")
    );
    const id = taskIdOf(sent);

    const viaRpc = await rpcCall(connection.token, "CancelTask", { id });
    const viaRest = await restCall(
      connection.token,
      "POST",
      `/tasks/${id}:cancel`,
      {}
    );

    expect(rpcFailure(viaRpc)).toEqual({
      code: -32_002,
      contentType: JSON_TYPE,
      data: [errorInfo("TASK_NOT_CANCELABLE")],
      httpStatus: 200,
    });
    expect(restFailure(viaRest)).toEqual({
      code: 400,
      contentType: A2A_TYPE,
      details: [errorInfo("TASK_NOT_CANCELABLE")],
      httpStatus: 400,
      status: "FAILED_PRECONDITION",
    });
  });
});

describe("push notification configs", () => {
  const CONFIG = { token: "t", url: "https://hooks.example.com/a" };

  test("CreateTaskPushNotificationConfig returns the same config on both bindings", async () => {
    const connection = await f.connect(agent);
    const onRpc = await f.seedTask(
      connection.connectionId,
      "TASK_STATE_WORKING"
    );
    const onRest = await f.seedTask(
      connection.connectionId,
      "TASK_STATE_WORKING"
    );

    const viaRpc = await rpcCall(
      connection.token,
      "CreateTaskPushNotificationConfig",
      { taskId: onRpc, ...CONFIG }
    );
    const viaRest = await restCall(
      connection.token,
      "POST",
      `/tasks/${onRest}/pushNotificationConfigs`,
      { url: CONFIG.url, token: CONFIG.token }
    );

    expect(field(viaRpc.body, "result", "url")).toBe(CONFIG.url);
    expect(field(viaRest.body, "url")).toBe(CONFIG.url);
    expect(leakedSecrets(viaRpc)).toEqual([]);
    expect(leakedSecrets(viaRest)).toEqual([]);
    expect(
      normalize(field(viaRpc.body, "result"), [connection.connectionId])
    ).toEqual(normalize(viaRest.body, [connection.connectionId]));
  });

  test("GetTaskPushNotificationConfig reads the same config on both bindings", async () => {
    const connection = await f.connect(agent);
    const taskId = await f.seedTask(
      connection.connectionId,
      "TASK_STATE_WORKING"
    );
    const created = await rpcCall(
      connection.token,
      "CreateTaskPushNotificationConfig",
      { taskId, ...CONFIG }
    );
    const id = String(field(created.body, "result", "id"));

    const viaRpc = await rpcCall(
      connection.token,
      "GetTaskPushNotificationConfig",
      { id, taskId }
    );
    const viaRest = await restCall(
      connection.token,
      "GET",
      `/tasks/${taskId}/pushNotificationConfigs/${id}`
    );

    expect(field(viaRpc.body, "result", "id")).toBe(id);
    expect(leakedSecrets(viaRpc)).toEqual([]);
    expect(leakedSecrets(viaRest)).toEqual([]);
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });

  test("ListTaskPushNotificationConfigs lists the same configs on both bindings", async () => {
    const connection = await f.connect(agent);
    const taskId = await f.seedTask(
      connection.connectionId,
      "TASK_STATE_WORKING"
    );
    await rpcCall(connection.token, "CreateTaskPushNotificationConfig", {
      taskId,
      ...CONFIG,
    });
    await restCall(
      connection.token,
      "POST",
      `/tasks/${taskId}/pushNotificationConfigs`,
      { url: "https://hooks.example.com/b", token: CONFIG.token }
    );

    const viaRpc = await rpcCall(
      connection.token,
      "ListTaskPushNotificationConfigs",
      { taskId }
    );
    const viaRest = await restCall(
      connection.token,
      "GET",
      `/tasks/${taskId}/pushNotificationConfigs`
    );

    expect(field(viaRpc.body, "result", "configs")).toHaveLength(2);
    expect(field(viaRpc.body, "result", "nextPageToken")).toBe("");
    expect(leakedSecrets(viaRpc)).toEqual([]);
    expect(leakedSecrets(viaRest)).toEqual([]);
    expect(viaRest.body).toEqual(field(viaRpc.body, "result"));
  });

  test("DeleteTaskPushNotificationConfig deletes on both bindings", async () => {
    const connection = await f.connect(agent);
    const taskId = await f.seedTask(
      connection.connectionId,
      "TASK_STATE_WORKING"
    );
    const one = await rpcCall(
      connection.token,
      "CreateTaskPushNotificationConfig",
      { taskId, ...CONFIG }
    );
    const two = await restCall(
      connection.token,
      "POST",
      `/tasks/${taskId}/pushNotificationConfigs`,
      { url: "https://hooks.example.com/b", token: CONFIG.token }
    );

    const viaRpc = await rpcCall(
      connection.token,
      "DeleteTaskPushNotificationConfig",
      { id: String(field(one.body, "result", "id")), taskId }
    );
    const viaRest = await restCall(
      connection.token,
      "DELETE",
      `/tasks/${taskId}/pushNotificationConfigs/${String(field(two.body, "id"))}`
    );

    expect(viaRpc.body).toEqual({ id: 1, jsonrpc: "2.0", result: {} });
    expect(viaRest.body).toEqual({});
    const left = await rpcCall(
      connection.token,
      "ListTaskPushNotificationConfigs",
      { taskId }
    );
    expect(field(left.body, "result", "configs")).toEqual([]);
  });
});

describe("GetExtendedAgentCard", () => {
  test("answers ExtendedAgentCardNotConfiguredError on both bindings", async () => {
    const connection = await f.connect(agent);

    const viaRpc = await rpcCall(connection.token, "GetExtendedAgentCard", {});
    const viaRest = await restCall(
      connection.token,
      "GET",
      "/extendedAgentCard"
    );

    expect(rpcFailure(viaRpc)).toEqual({
      code: -32_007,
      contentType: JSON_TYPE,
      data: [errorInfo("EXTENDED_AGENT_CARD_NOT_CONFIGURED")],
      httpStatus: 200,
    });
    expect(restFailure(viaRest)).toEqual({
      code: 400,
      contentType: A2A_TYPE,
      details: [errorInfo("EXTENDED_AGENT_CARD_NOT_CONFIGURED")],
      httpStatus: 400,
      status: "FAILED_PRECONDITION",
    });
  });
});

describe("errors", () => {
  test("an unknown task id is TaskNotFoundError on both bindings", async () => {
    const connection = await f.connect(agent);

    const viaRpc = await rpcCall(connection.token, "GetTask", {
      id: "tsk_missing",
    });
    const viaRest = await restCall(
      connection.token,
      "GET",
      "/tasks/tsk_missing"
    );

    expect(rpcFailure(viaRpc)).toEqual({
      code: -32_001,
      contentType: JSON_TYPE,
      data: [errorInfo("TASK_NOT_FOUND")],
      httpStatus: 200,
    });
    expect(restFailure(viaRest)).toEqual({
      code: 404,
      contentType: A2A_TYPE,
      details: [errorInfo("TASK_NOT_FOUND")],
      httpStatus: 404,
      status: "NOT_FOUND",
    });
  });

  test("another connection's task is TaskNotFoundError on both bindings", async () => {
    const owner = await f.connect(agent, "auto", "Owner");
    const other = await f.connect(agent, "auto", "Other");
    const sent = await rpcCall(
      owner.token,
      "SendMessage",
      textMessage("m1", "hi")
    );
    const id = taskIdOf(sent);

    const viaRpc = await rpcCall(other.token, "GetTask", { id });
    const viaRest = await restCall(other.token, "GET", `/tasks/${id}`);

    expect(rpcFailure(viaRpc)).toEqual({
      code: -32_001,
      contentType: JSON_TYPE,
      data: [errorInfo("TASK_NOT_FOUND")],
      httpStatus: 200,
    });
    expect(restFailure(viaRest)).toEqual({
      code: 404,
      contentType: A2A_TYPE,
      details: [errorInfo("TASK_NOT_FOUND")],
      httpStatus: 404,
      status: "NOT_FOUND",
    });
  });

  test.each([
    ["raw", { mediaType: "text/plain", raw: "aGVsbG8=" }],
    ["url", { url: "https://example.com/file.txt" }],
  ])(
    "a %s part is ContentTypeNotSupportedError on both bindings",
    async (_kind, part) => {
      const connection = await f.connect(agent);
      const message = {
        message: { messageId: "m-file", parts: [part], role: "ROLE_USER" },
      };

      const viaRpc = await rpcCall(connection.token, "SendMessage", message);
      const viaRest = await restCall(
        connection.token,
        "POST",
        "/message:send",
        message
      );

      expect(rpcFailure(viaRpc)).toEqual({
        code: -32_005,
        contentType: JSON_TYPE,
        data: [errorInfo("CONTENT_TYPE_NOT_SUPPORTED")],
        httpStatus: 200,
      });
      expect(restFailure(viaRest)).toEqual({
        code: 400,
        contentType: A2A_TYPE,
        details: [errorInfo("CONTENT_TYPE_NOT_SUPPORTED")],
        httpStatus: 400,
        status: "INVALID_ARGUMENT",
      });
    }
  );

  test("a SendMessage without message is InvalidParamsError on both bindings", async () => {
    const connection = await f.connect(agent);

    const viaRpc = await rpcCall(connection.token, "SendMessage", {});
    const viaRest = await restCall(
      connection.token,
      "POST",
      "/message:send",
      {}
    );

    expect(rpcFailure(viaRpc)).toEqual({
      code: -32_602,
      contentType: JSON_TYPE,
      data: undefined,
      httpStatus: 200,
    });
    expect(restFailure(viaRest)).toEqual({
      code: 400,
      contentType: A2A_TYPE,
      details: [],
      httpStatus: 400,
      status: "INVALID_ARGUMENT",
    });
  });
});

describe("JSON-RPC protocol errors", () => {
  test("a body that is not JSON is JSONParseError", async () => {
    const connection = await f.connect(agent);

    const value = await reply(
      await rawPost("/rpc", connection.token, "not json")
    );

    expect(rpcFailure(value)).toEqual({
      code: -32_700,
      contentType: JSON_TYPE,
      data: undefined,
      httpStatus: 200,
    });
    expect(field(value.body, "id")).toBeNull();
  });

  test("JSON that is not a request is InvalidRequestError", async () => {
    const connection = await f.connect(agent);

    const value = await reply(
      await rawPost(
        "/rpc",
        connection.token,
        JSON.stringify({ id: 7, method: "GetTask" })
      )
    );

    expect(rpcFailure(value)).toEqual({
      code: -32_600,
      contentType: JSON_TYPE,
      data: undefined,
      httpStatus: 200,
    });
    expect(field(value.body, "id")).toBe(7);
  });

  test("an unknown method is MethodNotFoundError", async () => {
    const connection = await f.connect(agent);

    const value = await rpcCall(connection.token, "NoSuchMethod", {});

    expect(rpcFailure(value)).toEqual({
      code: -32_601,
      contentType: JSON_TYPE,
      data: undefined,
      httpStatus: 200,
    });
  });
});

describe("HTTP+JSON routing", () => {
  test("an unknown path under /rest is a 404 A2A error body", async () => {
    const connection = await f.connect(agent);

    const value = await restCall(connection.token, "GET", "/no-such-route");

    expect(restFailure(value)).toEqual({
      code: 404,
      contentType: A2A_TYPE,
      details: [],
      httpStatus: 404,
      status: "NOT_FOUND",
    });
    expect(field(value.body, "error", "message")).toBe("Method not found");
  });

  test("a malformed JSON body on POST /message:send is JSONParseError", async () => {
    const connection = await f.connect(agent);

    const value = await reply(
      await rawPost("/rest/message:send", connection.token, "{not json")
    );

    expect(restFailure(value)).toEqual({
      code: 400,
      contentType: A2A_TYPE,
      details: [],
      httpStatus: 400,
      status: "INVALID_ARGUMENT",
    });
  });

  test("GET /tasks/abc:cancel is 404, not a cancel", async () => {
    const connection = await f.connect(agent);

    const value = await restCall(connection.token, "GET", "/tasks/abc:cancel");

    expect(restFailure(value)).toMatchObject({
      code: 404,
      httpStatus: 404,
      status: "NOT_FOUND",
    });
  });
});

describe("oversized bodies", () => {
  test("a body over 256 KiB is refused on JSON-RPC without crashing", async () => {
    const connection = await f.connect(agent);
    const big = textMessage("m-big", "x".repeat(300 * 1024));

    const value = await reply(
      await rawPost(
        "/rpc",
        connection.token,
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "SendMessage",
          params: big,
        })
      )
    );

    expect(rpcFailure(value)).toEqual({
      code: -32_600,
      contentType: JSON_TYPE,
      data: undefined,
      httpStatus: 200,
    });
  });

  test("a body over 256 KiB is refused on HTTP+JSON without crashing", async () => {
    const connection = await f.connect(agent);
    const big = textMessage("m-big", "x".repeat(300 * 1024));

    const value = await reply(
      await rawPost("/rest/message:send", connection.token, JSON.stringify(big))
    );

    expect(restFailure(value)).toEqual({
      code: 400,
      contentType: A2A_TYPE,
      details: [],
      httpStatus: 400,
      status: "INVALID_ARGUMENT",
    });
  });
});
