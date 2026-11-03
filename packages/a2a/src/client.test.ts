import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AgentCard } from "./agent-card.ts";
import { agentCardSchema } from "./agent-card.ts";
import {
  A2aClientError,
  type A2aClientOptions,
  type ClientCredential,
  createA2aClient,
  pickInterface,
  readAgentCard,
  taskText,
} from "./client.ts";
import hermesCard from "./fixtures/hermes-agent-card.json";
import hermesPushReply from "./fixtures/hermes-push-config-reply.json";
import hermesRpcError from "./fixtures/hermes-rpc-error.json";
import type { A2aFetch } from "./peer-fetch.ts";
import type { A2aBinding } from "./protocol.ts";
import type { SendMessageRequest } from "./requests.ts";
import type { TaskState } from "./states.ts";
import type { Task } from "./tasks.ts";

const PEER = "https://peer.example.com/a2a";
const TOKEN_URL = "https://auth.example.com/token";

interface Seen {
  headers: Headers;
  method: string;
  text: string;
  url: string;
}

/** A fake peer: records each request and answers with `answer`. No network. */
const recordingPeer = (
  answer: (seen: Seen) => Response
): { fetch: A2aFetch; seen: Seen[] } => {
  const seen: Seen[] = [];
  const fetch: A2aFetch = (url, init) => {
    const record: Seen = {
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      text: typeof init.body === "string" ? init.body : "",
      url,
    };
    seen.push(record);
    return Promise.resolve(answer(record));
  };
  return { fetch, seen };
};

const jsonBody = (seen: Seen): Record<string, unknown> =>
  JSON.parse(seen.text) as Record<string, unknown>;

/** A JSON-RPC peer that answers each method with its result, echoing the request id. */
const rpcPeer = (results: Record<string, unknown>) =>
  recordingPeer((seen) => {
    const request = jsonBody(seen);
    return Response.json({
      id: request.id,
      jsonrpc: "2.0",
      result: results[String(request.method)],
    });
  });

const makeClient = (
  fetch: A2aFetch,
  binding: A2aBinding = "JSONRPC",
  extra: Partial<A2aClientOptions> = {}
) =>
  createA2aClient({
    credential: { kind: "none" },
    fetch,
    interface: { binding, url: PEER },
    ...extra,
  });

const task = (
  id = "task-1",
  state: TaskState = "TASK_STATE_WORKING"
): Task => ({
  contextId: "ctx-1",
  id,
  status: { state },
});

const request: SendMessageRequest = {
  message: {
    messageId: "m1",
    parts: [{ text: "hello" }],
    role: "ROLE_USER",
  },
};

const hermesAgentCard = (): AgentCard => agentCardSchema.parse(hermesCard);

const withInterfaces = (
  interfaces: AgentCard["supportedInterfaces"]
): AgentCard => ({ ...hermesAgentCard(), supportedInterfaces: interfaces });

/** The error a call throws. Fails the test when the call succeeds. */
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
};

describe("pickInterface", () => {
  test("picks JSONRPC 1.0 over HTTP+JSON", () => {
    const picked = pickInterface(
      withInterfaces([
        {
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
          url: "https://peer.example.com/rest",
        },
        {
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          url: "https://peer.example.com/rpc",
        },
      ])
    );
    expect(picked).toEqual({
      binding: "JSONRPC",
      origin: "https://peer.example.com",
      url: "https://peer.example.com/rpc",
    });
  });

  test("falls back to HTTP+JSON when JSONRPC is not offered", () => {
    const picked = pickInterface(
      withInterfaces([
        {
          protocolBinding: "GRPC",
          protocolVersion: "1.0",
          url: "https://peer.example.com/grpc",
        },
        {
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
          url: "https://peer.example.com/rest",
        },
      ])
    );
    expect(picked?.binding).toBe("HTTP+JSON");
    expect(picked?.url).toBe("https://peer.example.com/rest");
  });

  test("returns null when no interface is one this package can call", () => {
    expect(
      pickInterface(
        withInterfaces([
          {
            protocolBinding: "GRPC",
            protocolVersion: "1.0",
            url: "https://peer.example.com/grpc",
          },
        ])
      )
    ).toBeNull();
  });

  test("accepts Hermes's card", () => {
    expect(pickInterface(hermesAgentCard())).toEqual({
      binding: "JSONRPC",
      origin: "https://hermes.example.com",
      url: "https://hermes.example.com/a2a",
    });
  });
});

describe("requests on both bindings", () => {
  test("sendMessage sends the JSON-RPC envelope and the spec headers, and returns the task", async () => {
    const peer = rpcPeer({ SendMessage: { task: task() } });
    const result = await makeClient(peer.fetch).sendMessage(request);
    expect(result).toEqual({ task: task() });
    const [sent] = peer.seen;
    expect(sent?.headers.get("A2A-Version")).toBe("1.0");
    expect(sent?.headers.get("Accept")).toBe("application/json");
    expect(sent?.headers.get("Content-Type")).toBe("application/json");
    expect(jsonBody(sent as Seen)).toMatchObject({
      jsonrpc: "2.0",
      method: "SendMessage",
      params: request,
    });
  });

  test("sendMessage posts to /message:send on HTTP+JSON", async () => {
    const peer = recordingPeer(() => Response.json({ task: task() }));
    const result = await makeClient(peer.fetch, "HTTP+JSON").sendMessage(
      request
    );
    expect(result).toEqual({ task: task() });
    expect(peer.seen[0]?.method).toBe("POST");
    expect(peer.seen[0]?.url).toBe(`${PEER}/message:send`);
    expect(jsonBody(peer.seen[0] as Seen)).toEqual(request);
  });

  test("getTask reads a task on both bindings", async () => {
    const rpc = rpcPeer({ GetTask: task() });
    expect(await makeClient(rpc.fetch).getTask("task-1")).toEqual(task());
    expect(jsonBody(rpc.seen[0] as Seen)).toMatchObject({
      method: "GetTask",
      params: { id: "task-1" },
    });

    const rest = recordingPeer(() => Response.json(task()));
    expect(await makeClient(rest.fetch, "HTTP+JSON").getTask("task-1")).toEqual(
      task()
    );
    expect(rest.seen[0]?.method).toBe("GET");
    expect(rest.seen[0]?.url).toBe(`${PEER}/tasks/task-1`);
  });

  test("listTasks sends only the filters that are set, on both bindings", async () => {
    const rpc = rpcPeer({ ListTasks: { tasks: [task()] } });
    const client = makeClient(rpc.fetch);
    expect(
      await client.listTasks({ contextId: "ctx-1", pageSize: 10 })
    ).toEqual([task()]);
    expect(jsonBody(rpc.seen[0] as Seen)).toMatchObject({
      method: "ListTasks",
      params: { contextId: "ctx-1", pageSize: 10 },
    });
    await client.listTasks({});
    expect(jsonBody(rpc.seen[1] as Seen).params).toEqual({});

    const rest = recordingPeer(() => Response.json({ tasks: [task()] }));
    const restClient = makeClient(rest.fetch, "HTTP+JSON");
    expect(
      await restClient.listTasks({ contextId: "ctx-1", pageSize: 10 })
    ).toEqual([task()]);
    expect(rest.seen[0]?.url).toBe(`${PEER}/tasks?contextId=ctx-1&pageSize=10`);
    await restClient.listTasks({});
    expect(rest.seen[1]?.url).toBe(`${PEER}/tasks`);
  });

  test("cancelTask cancels on both bindings", async () => {
    const rpc = rpcPeer({ CancelTask: task("task-1", "TASK_STATE_CANCELED") });
    expect(
      (await makeClient(rpc.fetch).cancelTask("task-1")).status.state
    ).toBe("TASK_STATE_CANCELED");
    expect(jsonBody(rpc.seen[0] as Seen)).toMatchObject({
      method: "CancelTask",
      params: { id: "task-1" },
    });

    const rest = recordingPeer(() =>
      Response.json(task("task-1", "TASK_STATE_CANCELED"))
    );
    await makeClient(rest.fetch, "HTTP+JSON").cancelTask("task-1");
    expect(rest.seen[0]?.method).toBe("POST");
    expect(rest.seen[0]?.url).toBe(`${PEER}/tasks/task-1:cancel`);
    expect(jsonBody(rest.seen[0] as Seen)).toEqual({});
  });
});

describe("credentials", () => {
  test("bearer sends Authorization: Bearer", async () => {
    const peer = rpcPeer({ GetTask: task() });
    await makeClient(peer.fetch, "JSONRPC", {
      credential: { kind: "bearer", token: "t-123" },
    }).getTask("task-1");
    expect(peer.seen[0]?.headers.get("Authorization")).toBe("Bearer t-123");
  });

  test("api_key_header sends the named header", async () => {
    const peer = rpcPeer({ GetTask: task() });
    await makeClient(peer.fetch, "JSONRPC", {
      credential: {
        headerName: "X-Api-Key",
        kind: "api_key_header",
        value: "k-9",
      },
    }).getTask("task-1");
    expect(peer.seen[0]?.headers.get("X-Api-Key")).toBe("k-9");
    expect(peer.seen[0]?.headers.get("Authorization")).toBeNull();
  });

  test("none sends no credential header", async () => {
    const peer = rpcPeer({ GetTask: task() });
    await makeClient(peer.fetch).getTask("task-1");
    expect(peer.seen[0]?.headers.get("Authorization")).toBeNull();
  });

  describe("oauth2_client_credentials", () => {
    const oauth: ClientCredential = {
      clientId: "hm",
      clientSecret: "s3cret",
      kind: "oauth2_client_credentials",
      scopes: ["a2a.send", "a2a.read"],
      tokenUrl: TOKEN_URL,
    };

    /**
     * A token endpoint that grants tok-1, tok-2, ... and an A2A endpoint that
     * answers with 401 when the request carries `rejected`.
     */
    const oauthPeer = (
      options: { expiresIn?: number; rejected?: string } = {}
    ) => {
      let issued = 0;
      return recordingPeer((seen) => {
        if (seen.url === TOKEN_URL) {
          issued += 1;
          return Response.json({
            access_token: `tok-${issued}`,
            expires_in: options.expiresIn ?? 300,
            token_type: "Bearer",
          });
        }
        if (
          seen.headers.get("Authorization") === `Bearer ${options.rejected}`
        ) {
          return new Response("no", { status: 401 });
        }
        return Response.json(task());
      });
    };

    const tokenRequests = (seen: Seen[]) =>
      seen.filter((entry) => entry.url === TOKEN_URL);

    test("requests a token once with Basic auth and reuses it", async () => {
      const peer = oauthPeer();
      const client = makeClient(peer.fetch, "HTTP+JSON", { credential: oauth });
      await client.getTask("task-1");
      await client.getTask("task-1");

      const [token] = tokenRequests(peer.seen);
      expect(tokenRequests(peer.seen)).toHaveLength(1);
      expect(token?.method).toBe("POST");
      expect(token?.headers.get("Authorization")).toBe(
        `Basic ${btoa("hm:s3cret")}`
      );
      expect(token?.headers.get("Content-Type")).toBe(
        "application/x-www-form-urlencoded"
      );
      const form = new URLSearchParams(token?.text);
      expect(form.get("grant_type")).toBe("client_credentials");
      expect(form.get("scope")).toBe("a2a.send a2a.read");

      const calls = peer.seen.filter((entry) => entry.url !== TOKEN_URL);
      expect(calls.map((entry) => entry.headers.get("Authorization"))).toEqual([
        "Bearer tok-1",
        "Bearer tok-1",
      ]);
    });

    test("requests a new token after the cached one expires, by the injected clock", async () => {
      let clock = 0;
      const peer = oauthPeer({ expiresIn: 300 });
      const client = makeClient(peer.fetch, "HTTP+JSON", {
        credential: oauth,
        now: () => clock,
      });
      await client.getTask("task-1");
      clock = 269_000;
      await client.getTask("task-1");
      expect(tokenRequests(peer.seen)).toHaveLength(1);
      clock = 270_000;
      await client.getTask("task-1");
      expect(tokenRequests(peer.seen)).toHaveLength(2);
      expect(peer.seen.at(-1)?.headers.get("Authorization")).toBe(
        "Bearer tok-2"
      );
    });

    test("refetches the token once after the peer answers 401", async () => {
      const peer = oauthPeer({ rejected: "tok-1" });
      const client = makeClient(peer.fetch, "HTTP+JSON", { credential: oauth });
      expect(await client.getTask("task-1")).toEqual(task());
      expect(tokenRequests(peer.seen)).toHaveLength(2);
      const calls = peer.seen.filter((entry) => entry.url !== TOKEN_URL);
      expect(calls.map((entry) => entry.headers.get("Authorization"))).toEqual([
        "Bearer tok-1",
        "Bearer tok-2",
      ]);
    });

    test("a token endpoint failure is kind auth and names no secret", async () => {
      const peer = recordingPeer(() => new Response("denied", { status: 500 }));
      const client = makeClient(peer.fetch, "HTTP+JSON", { credential: oauth });
      const error = await client
        .getTask("task-1")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(A2aClientError);
      expect((error as A2aClientError).kind).toBe("auth");
      expect((error as A2aClientError).message).not.toContain("s3cret");
    });
  });
});

describe("malformed answers", () => {
  test("a body that is not JSON is invalid_response", async () => {
    const peer = recordingPeer(() => new Response("<html>", { status: 200 }));
    expect(
      await failureOf(makeClient(peer.fetch, "HTTP+JSON").getTask("task-1"))
    ).toMatchObject({ kind: "invalid_response" });
  });

  test("a JSON-RPC response with both result and error is invalid_response", async () => {
    const peer = recordingPeer((seen) =>
      Response.json({
        error: { code: -1, message: "x" },
        id: jsonBody(seen).id,
        jsonrpc: "2.0",
        result: task(),
      })
    );
    expect(
      await failureOf(makeClient(peer.fetch).getTask("task-1"))
    ).toMatchObject({ kind: "invalid_response" });
  });

  test("a task with an unknown state is invalid_response", async () => {
    const peer = rpcPeer({
      GetTask: { id: "task-1", status: { state: "TASK_STATE_NAPPING" } },
    });
    expect(
      await failureOf(makeClient(peer.fetch).getTask("task-1"))
    ).toMatchObject({ kind: "invalid_response" });
  });

  test("a getTask answer for another task is invalid_response", async () => {
    const peer = rpcPeer({ GetTask: task("task-2") });
    expect(
      await failureOf(makeClient(peer.fetch).getTask("task-1"))
    ).toMatchObject({ kind: "invalid_response" });
  });

  test("a SendMessage answer with neither task nor message is invalid_response", async () => {
    const peer = rpcPeer({ SendMessage: {} });
    expect(
      await failureOf(makeClient(peer.fetch).sendMessage(request))
    ).toMatchObject({ kind: "invalid_response" });
  });

  test("a body over maxBodyBytes is too_large", async () => {
    const peer = recordingPeer(() =>
      Response.json({ padding: "x".repeat(500), tasks: [] })
    );
    expect(
      await failureOf(
        makeClient(peer.fetch, "HTTP+JSON", { maxBodyBytes: 100 }).listTasks({})
      )
    ).toMatchObject({ kind: "too_large" });
  });
});

describe("errors", () => {
  test("a JSON-RPC error without data is kind rpc with its code", async () => {
    const peer = recordingPeer(() => Response.json(hermesRpcError));
    const error = await makeClient(peer.fetch)
      .getTask("task-1")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "rpc",
      message: "Task not found",
      rpcCode: -32_001,
    });
  });

  test("a 401 is kind auth", async () => {
    const peer = recordingPeer(() => new Response("no", { status: 401 }));
    expect(
      await failureOf(makeClient(peer.fetch).getTask("task-1"))
    ).toMatchObject({ kind: "auth" });
    expect(
      await failureOf(makeClient(peer.fetch, "HTTP+JSON").getTask("task-1"))
    ).toMatchObject({ kind: "auth" });
  });

  test("a 500 is kind http", async () => {
    const peer = recordingPeer(() => new Response("boom", { status: 500 }));
    expect(
      await failureOf(makeClient(peer.fetch, "HTTP+JSON").getTask("task-1"))
    ).toMatchObject({ kind: "http" });
  });

  test("a fetch that never answers is kind timeout", async () => {
    const hanging: A2aFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        );
      });
    const client = makeClient(hanging, "JSONRPC", { timeoutMs: 20 });
    expect(await failureOf(client.getTask("task-1"))).toMatchObject({
      kind: "timeout",
    });
  });

  test("a fetch that throws is kind network", async () => {
    const broken: A2aFetch = () =>
      Promise.reject(new TypeError("fetch failed"));
    expect(await failureOf(makeClient(broken).getTask("task-1"))).toMatchObject(
      { kind: "network" }
    );
  });
});

describe("createPushConfig", () => {
  const config = {
    authentication: { credentials: "peer-secret", scheme: "bearer" },
    token: "tok-hook",
    url: "https://agentum.example.com/a2a/webhooks/task-1/tok",
  };

  test("sends the superset body on both bindings", async () => {
    const rpc = rpcPeer({
      CreateTaskPushNotificationConfig: hermesPushReply.result,
    });
    await makeClient(rpc.fetch).createPushConfig("task-1", config);
    const expected = {
      authentication: { credentials: "peer-secret", scheme: "bearer" },
      pushNotificationConfig: {
        authentication: { credentials: "peer-secret", scheme: "bearer" },
        token: "tok-hook",
        url: config.url,
      },
      taskId: "task-1",
      token: "tok-hook",
      url: config.url,
    };
    expect(jsonBody(rpc.seen[0] as Seen)).toMatchObject({
      method: "CreateTaskPushNotificationConfig",
      params: expected,
    });

    const rest = recordingPeer(() => Response.json(hermesPushReply.result));
    await makeClient(rest.fetch, "HTTP+JSON").createPushConfig(
      "task-1",
      config
    );
    expect(rest.seen[0]?.url).toBe(
      `${PEER}/tasks/task-1/pushNotificationConfigs`
    );
    expect(jsonBody(rest.seen[0] as Seen)).toEqual(expected);
  });

  test("accepts Hermes's reply, which the task config schema would refuse", async () => {
    const peer = recordingPeer((seen) =>
      Response.json({ ...hermesPushReply, id: jsonBody(seen).id })
    );
    await expect(
      makeClient(peer.fetch).createPushConfig("task-1", config)
    ).resolves.toBeUndefined();
  });

  test("a JSON-RPC error from the peer is thrown", async () => {
    const peer = recordingPeer(() => Response.json(hermesRpcError));
    expect(
      await failureOf(makeClient(peer.fetch).createPushConfig("task-1", config))
    ).toMatchObject({ kind: "rpc" });
  });
});

describe("readAgentCard", () => {
  test("parses Hermes's card and ignores its extra fields", async () => {
    const peer = recordingPeer(() => Response.json(hermesCard));
    const card = await readAgentCard(
      peer.fetch,
      `${PEER}/.well-known/agent-card.json`
    );
    expect(card.name).toBe("Hermes");
    expect(card.securitySchemes?.bearer).toMatchObject({
      httpAuthSecurityScheme: { scheme: "bearer" },
    });
    expect(card).not.toHaveProperty("url");
  });

  test("refuses an invalid card", async () => {
    const peer = recordingPeer(() => Response.json({ name: "no skills here" }));
    expect(
      await failureOf(readAgentCard(peer.fetch, `${PEER}/card`))
    ).toMatchObject({ kind: "invalid_response" });
  });
});

describe("taskText", () => {
  test("reads the text of the first artifact", () => {
    expect(
      taskText({
        ...task(),
        artifacts: [
          { artifactId: "a1", parts: [{ data: { n: 1 } }] },
          { artifactId: "a2", parts: [{ text: "Sunny" }, { text: "75F" }] },
          { artifactId: "a3", parts: [{ text: "later" }] },
        ],
        status: {
          message: {
            messageId: "m",
            parts: [{ text: "status" }],
            role: "ROLE_AGENT",
          },
          state: "TASK_STATE_COMPLETED",
        },
      })
    ).toBe("Sunny\n\n75F");
  });

  test("falls back to the status message", () => {
    expect(
      taskText({
        ...task(),
        status: {
          message: {
            messageId: "m",
            parts: [{ text: "Waiting for approval" }],
            role: "ROLE_AGENT",
          },
          state: "TASK_STATE_INPUT_REQUIRED",
        },
      })
    ).toBe("Waiting for approval");
  });

  test("is empty when there is no text", () => {
    expect(taskText(task())).toBe("");
  });
});

describe("module boundary", () => {
  test("client.ts imports only zod and its own files", () => {
    const source = readFileSync(
      new URL("./client.ts", import.meta.url),
      "utf8"
    );
    const sources = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const specifier of sources) {
      expect(specifier === "zod" || specifier?.startsWith("./")).toBe(true);
    }
  });
});
