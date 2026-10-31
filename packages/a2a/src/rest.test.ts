import { describe, expect, test } from "bun:test";
import { isJsonRpcMethod, type JsonRpcMethod } from "./jsonrpc.ts";
import { matchRestRoute, REST_ROUTES, type RestMatch } from "./rest.ts";

const found = (verb: string, path: string): RestMatch => {
  const match = matchRestRoute(verb, path);
  if (!match) {
    throw new Error(`no route for ${verb} ${path}`);
  }
  return match;
};

describe("the REST route table", () => {
  test("every route names a JSON-RPC operation", () => {
    for (const route of REST_ROUTES) {
      expect(isJsonRpcMethod(route.operation)).toBe(true);
    }
  });

  test("every operation has a route, and no verb and path repeat", () => {
    const operations = new Set(REST_ROUTES.map((route) => route.operation));
    expect(operations.size).toBe(11);
    const keys = REST_ROUTES.map((route) => `${route.verb} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("matches the spec's operations", () => {
    const cases: [string, string, JsonRpcMethod, Record<string, string>][] = [
      ["POST", "/message:send", "SendMessage", {}],
      ["POST", "/message:stream", "SendStreamingMessage", {}],
      ["GET", "/tasks/t1", "GetTask", { id: "t1" }],
      ["GET", "/tasks", "ListTasks", {}],
      ["POST", "/tasks/t1:cancel", "CancelTask", { id: "t1" }],
      ["GET", "/tasks/t1:subscribe", "SubscribeToTask", { id: "t1" }],
      ["POST", "/tasks/t1:subscribe", "SubscribeToTask", { id: "t1" }],
      [
        "POST",
        "/tasks/t1/pushNotificationConfigs",
        "CreateTaskPushNotificationConfig",
        { taskId: "t1" },
      ],
      [
        "GET",
        "/tasks/t1/pushNotificationConfigs/c1",
        "GetTaskPushNotificationConfig",
        { id: "c1", taskId: "t1" },
      ],
      [
        "GET",
        "/tasks/t1/pushNotificationConfigs",
        "ListTaskPushNotificationConfigs",
        { taskId: "t1" },
      ],
      [
        "DELETE",
        "/tasks/t1/pushNotificationConfigs/c1",
        "DeleteTaskPushNotificationConfig",
        { id: "c1", taskId: "t1" },
      ],
      ["GET", "/extendedAgentCard", "GetExtendedAgentCard", {}],
    ];
    for (const [verb, path, operation, params] of cases) {
      const match = found(verb, path);
      expect(match.route.operation).toBe(operation);
      expect(match.params).toEqual(params);
    }
  });

  test("streaming routes are flagged", () => {
    expect(found("POST", "/message:stream").route.streaming).toBe(true);
    expect(found("GET", "/tasks/t1:subscribe").route.streaming).toBe(true);
    expect(found("POST", "/message:send").route.streaming).toBe(false);
  });

  test("decodes path parameters", () => {
    expect(found("GET", "/tasks/a%20b").params).toEqual({
      id: "a b",
    });
  });

  test("a colon verb is not read as part of an id", () => {
    expect(matchRestRoute("GET", "/tasks/t1:cancel")).toBeNull();
    expect(matchRestRoute("POST", "/tasks/t1:other")).toBeNull();
  });

  test("a wrong verb or an unknown path matches nothing", () => {
    expect(matchRestRoute("GET", "/message:send")).toBeNull();
    expect(matchRestRoute("DELETE", "/tasks/t1")).toBeNull();
    expect(matchRestRoute("GET", "/nothing")).toBeNull();
    expect(matchRestRoute("GET", "/tasks/t1/extra")).toBeNull();
  });
});
