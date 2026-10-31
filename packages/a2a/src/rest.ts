import type { JsonRpcMethod } from "./jsonrpc.ts";

export type RestVerb = "DELETE" | "GET" | "POST";

export interface RestRoute {
  /** The same operation's JSON-RPC method name. */
  operation: JsonRpcMethod;
  /** Path under the interface URL. `{name}` is one path segment. */
  path: string;
  /** The response is a `text/event-stream`. */
  streaming: boolean;
  verb: RestVerb;
}

const route = (
  verb: RestVerb,
  path: string,
  operation: JsonRpcMethod,
  streaming = false
): RestRoute => ({ operation, path, streaming, verb });

/**
 * The HTTP+JSON operations, from the proto's `google.api.http` bindings
 * (spec section 11.3). `SubscribeToTask` is `GET` in the proto and `POST` in
 * the prose, so both are accepted. The `/{tenant}/...` variants are not
 * served: our interfaces declare no tenant.
 */
export const REST_ROUTES: readonly RestRoute[] = [
  route("POST", "/message:send", "SendMessage"),
  route("POST", "/message:stream", "SendStreamingMessage", true),
  route("GET", "/tasks/{id}", "GetTask"),
  route("GET", "/tasks", "ListTasks"),
  route("POST", "/tasks/{id}:cancel", "CancelTask"),
  route("GET", "/tasks/{id}:subscribe", "SubscribeToTask", true),
  route("POST", "/tasks/{id}:subscribe", "SubscribeToTask", true),
  route(
    "POST",
    "/tasks/{taskId}/pushNotificationConfigs",
    "CreateTaskPushNotificationConfig"
  ),
  route(
    "GET",
    "/tasks/{taskId}/pushNotificationConfigs/{id}",
    "GetTaskPushNotificationConfig"
  ),
  route(
    "GET",
    "/tasks/{taskId}/pushNotificationConfigs",
    "ListTaskPushNotificationConfigs"
  ),
  route(
    "DELETE",
    "/tasks/{taskId}/pushNotificationConfigs/{id}",
    "DeleteTaskPushNotificationConfig"
  ),
  route("GET", "/extendedAgentCard", "GetExtendedAgentCard"),
];

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const PARAM_SPLIT = /(\{\w+\})/;

/** A path segment holds no `/` and no `:`, so `/tasks/{id}:cancel` never reads `x:cancel` as an id. */
const compile = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split(PARAM_SPLIT)
      .map((part) =>
        part.startsWith("{")
          ? `(?<${part.slice(1, -1)}>[^/:]+)`
          : part.replace(REGEX_SPECIALS, "\\$&")
      )
      .join("")}$`
  );

const COMPILED = REST_ROUTES.map((entry) => ({
  entry,
  pattern: compile(entry.path),
}));

/** A malformed escape such as `%E0%A4%A` is no route, not an exception. */
const decodeParams = (
  raw: Record<string, string>
): Record<string, string> | null => {
  try {
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        decodeURIComponent(value),
      ])
    );
  } catch {
    return null;
  }
};

export interface RestMatch {
  params: Record<string, string>;
  route: RestRoute;
}

/**
 * Finds the route for a request, with its path parameters decoded. `path` is
 * relative to the interface URL, without a query string.
 */
export const matchRestRoute = (
  verb: string,
  path: string
): RestMatch | null => {
  for (const { entry, pattern } of COMPILED) {
    if (entry.verb !== verb) {
      continue;
    }
    const found = pattern.exec(path);
    if (found) {
      const params = decodeParams(found.groups ?? {});
      if (!params) {
        return null;
      }
      return {
        params,
        route: entry,
      };
    }
  }
  return null;
};
