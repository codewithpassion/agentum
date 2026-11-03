import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CloudStart } from "@repo/services/cloud/types";
import {
  listMcpTools,
  type McpFetch,
  type McpSessions,
  type McpTool,
  mcpToolOrigins,
  mcpToolRegistrations,
  type ServerTools,
  syncMcpTools,
  throttled,
  toolChanges,
} from "./pi-run-mcp.ts";

type McpServerEntry = CloudStart["mcpServers"][string];

interface RpcRequest {
  id?: number;
  jsonrpc: string;
  method: string;
  params?: unknown;
}

interface Call {
  body: RpcRequest;
  init: RequestInit;
  url: string;
}

const URL_ = "https://mcp.example.test/mcp";
const SERVER: McpServerEntry = {
  headers: { Authorization: "Bearer first" },
  type: "http",
  url: URL_,
};
// The MCP tool never reads the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const CONTEXT: Context = {
  abortSignal: undefined,
  toString: () => "test-context",
  value: () => undefined,
};

const SEARCH: McpTool = {
  annotations: { readOnlyHint: true },
  description: "Searches things.",
  inputSchema: { properties: { q: { type: "string" } }, type: "object" },
  name: "search",
};

/** The item at `index`. A missing item fails the test. */
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no item at ${index}`);
  }
  return item;
};

const jsonReply = (result: unknown): Response =>
  Response.json({ id: 1, jsonrpc: "2.0", result });

/** A fake fetch that records each call and answers with `reply`. */
const fakeFetch = (reply: (body: RpcRequest) => Response) => {
  const calls: Call[] = [];
  const fetcher: McpFetch = (url, init) => {
    const body: RpcRequest = JSON.parse(String(init.body));
    calls.push({ body, init, url });
    return Promise.resolve(reply(body));
  };
  return { calls, fetcher };
};

const toolsListReply = (body: RpcRequest): Response =>
  body.method === "initialize"
    ? jsonReply({ protocolVersion: "2025-06-18" })
    : jsonReply({ tools: [SEARCH] });

/** The calls with one method, in the order they were sent. */
const callsTo = (calls: readonly Call[], method: string): Call[] =>
  calls.filter((call) => call.body.method === method);

const headerOf = (call: Call, name: string): string | null =>
  new Headers(call.init.headers).get(name);

describe("listMcpTools", () => {
  test("sends initialize, notifications/initialized, then tools/list and returns the tools", async () => {
    const { calls, fetcher } = fakeFetch(toolsListReply);

    const tools = await listMcpTools(SERVER, fetcher);

    expect(tools).toEqual([SEARCH]);
    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(at(calls, 0).body.params).toEqual({
      capabilities: {},
      clientInfo: { name: "agentum-cloud-runtime", version: "0" },
      protocolVersion: "2025-06-18",
    });
    expect(at(calls, 0).url).toBe(URL_);
    const headers = new Headers(at(calls, 2).init.headers);
    expect(headers.get("Accept")).toBe("application/json, text/event-stream");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer first");
  });

  test("parses an SSE reply and takes its last data line", async () => {
    const sse = (body: RpcRequest): Response => {
      const payload =
        body.method === "initialize"
          ? { jsonrpc: "2.0", result: {} }
          : { jsonrpc: "2.0", result: { tools: [SEARCH] } };
      return new Response(
        `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify(payload)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    };
    const { fetcher } = fakeFetch(sse);

    expect(await listMcpTools(SERVER, fetcher)).toEqual([SEARCH]);
  });

  test("throws on a non-ok status", async () => {
    const { fetcher } = fakeFetch(() => new Response("nope", { status: 500 }));

    await expect(listMcpTools(SERVER, fetcher)).rejects.toThrow(
      "MCP initialize failed: 500"
    );
  });

  test("throws the message of a JSON-RPC error", async () => {
    const { fetcher } = fakeFetch(() =>
      Response.json({
        error: { code: -32_601, message: "no such method" },
        id: 1,
        jsonrpc: "2.0",
      })
    );

    await expect(listMcpTools(SERVER, fetcher)).rejects.toThrow(
      "no such method"
    );
  });
});

/**
 * A fake stateful MCP server. `initialize` issues a session id in the
 * `Mcp-Session-Id` header. Any other request without the header gets 400, and one
 * with an unknown id gets 404. `forget` drops every session, as a restart would.
 */
const statefulServer = () => {
  const live = new Set<string>();
  const calls: Call[] = [];
  let issued = 0;
  const fetcher: McpFetch = (url, init) => {
    const body: RpcRequest = JSON.parse(String(init.body));
    const call: Call = { body, init, url };
    calls.push(call);
    if (body.method === "initialize") {
      issued += 1;
      const session = `session-${issued}`;
      live.add(session);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            result: { protocolVersion: "2025-06-18" },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Mcp-Session-Id": session,
            },
          }
        )
      );
    }
    const session = headerOf(call, "Mcp-Session-Id");
    if (session === null) {
      return Promise.resolve(new Response("no session", { status: 400 }));
    }
    if (!live.has(session)) {
      return Promise.resolve(new Response("unknown session", { status: 404 }));
    }
    if (body.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return Promise.resolve(
      jsonReply(
        body.method === "tools/list"
          ? { tools: [SEARCH] }
          : { content: [{ text: "ok", type: "text" }] }
      )
    );
  };
  return { calls, fetcher, forget: () => live.clear() };
};

describe("stateful sessions", () => {
  const registrationWith = (
    fetcher: McpFetch,
    sessions: McpSessions
  ): ToolRegistration =>
    at(
      mcpToolRegistrations(
        "s",
        [SEARCH],
        () => Promise.resolve(SERVER),
        fetcher,
        undefined,
        sessions
      ),
      0
    );

  test("lists, then calls in the session that initialize issued", async () => {
    const server = statefulServer();
    const sessions: McpSessions = new Map();

    expect(await listMcpTools(SERVER, server.fetcher, sessions)).toEqual([
      SEARCH,
    ]);
    const result = await registrationWith(server.fetcher, sessions).execute(
      {},
      NO_API,
      CONTEXT
    );

    expect(result.output).toEqual([{ text: "ok", type: "text" }]);
    expect(server.calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(headerOf(at(server.calls, 0), "Mcp-Session-Id")).toBeNull();
    const notified = at(server.calls, 1);
    expect(notified.body).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(headerOf(notified, "Mcp-Session-Id")).toBe("session-1");
    expect(headerOf(notified, "Mcp-Protocol-Version")).toBe("2025-06-18");
    expect(headerOf(at(server.calls, 2), "Mcp-Session-Id")).toBe("session-1");
    expect(headerOf(at(server.calls, 3), "Mcp-Session-Id")).toBe("session-1");
    expect(headerOf(at(server.calls, 3), "Mcp-Protocol-Version")).toBe(
      "2025-06-18"
    );
  });

  test("initializes once for several calls", async () => {
    const server = statefulServer();
    const sessions: McpSessions = new Map();
    const registration = registrationWith(server.fetcher, sessions);

    await registration.execute({}, NO_API, CONTEXT);
    await registration.execute({}, NO_API, CONTEXT);
    await listMcpTools(SERVER, server.fetcher, sessions);

    expect(callsTo(server.calls, "initialize")).toHaveLength(1);
    expect(callsTo(server.calls, "tools/call")).toHaveLength(2);
  });

  test("re-initializes a lost session and the call succeeds", async () => {
    const server = statefulServer();
    const sessions: McpSessions = new Map();
    const registration = registrationWith(server.fetcher, sessions);
    await registration.execute({}, NO_API, CONTEXT);

    server.forget();
    const result = await registration.execute({}, NO_API, CONTEXT);

    expect(result.output).toEqual([{ text: "ok", type: "text" }]);
    expect(callsTo(server.calls, "initialize")).toHaveLength(2);
    // The first call, the refused one, and the retry in the new session.
    const toolCalls = callsTo(server.calls, "tools/call");
    expect(toolCalls).toHaveLength(3);
    expect(headerOf(at(toolCalls, 1), "Mcp-Session-Id")).toBe("session-1");
    expect(headerOf(at(toolCalls, 2), "Mcp-Session-Id")).toBe("session-2");
  });

  test("throws when the request is refused again after the retry", async () => {
    const server = statefulServer();
    let refused = 0;
    const refusing: McpFetch = (url, init) => {
      if (JSON.parse(String(init.body)).method !== "tools/call") {
        return server.fetcher(url, init);
      }
      refused += 1;
      return Promise.resolve(new Response("gone", { status: 404 }));
    };
    const registration = registrationWith(refusing, new Map());

    await expect(registration.execute({}, NO_API, CONTEXT)).rejects.toThrow(
      "MCP tools/call failed: 404"
    );
    expect(refused).toBe(2);
    expect(callsTo(server.calls, "initialize")).toHaveLength(2);
  });

  test("two parallel calls with no session initialize once", async () => {
    const server = statefulServer();
    const sessions: McpSessions = new Map();

    const [first, second] = await Promise.all([
      listMcpTools(SERVER, server.fetcher, sessions),
      listMcpTools(SERVER, server.fetcher, sessions),
    ]);

    expect(first).toEqual([SEARCH]);
    expect(second).toEqual([SEARCH]);
    expect(callsTo(server.calls, "initialize")).toHaveLength(1);
    expect(
      callsTo(server.calls, "tools/list").every(
        (call) => headerOf(call, "Mcp-Session-Id") === "session-1"
      )
    ).toBe(true);
  });

  test("a failed initialize is not kept, so the next call initializes again", async () => {
    const server = statefulServer();
    let busy = true;
    const flaky: McpFetch = (url, init) => {
      if (busy) {
        busy = false;
        return Promise.resolve(new Response("busy", { status: 503 }));
      }
      return server.fetcher(url, init);
    };
    const sessions: McpSessions = new Map();

    await expect(listMcpTools(SERVER, flaky, sessions)).rejects.toThrow(
      "MCP initialize failed: 503"
    );
    expect(await listMcpTools(SERVER, flaky, sessions)).toEqual([SEARCH]);
    expect(callsTo(server.calls, "initialize")).toHaveLength(1);
  });

  test("a stateless server works and no request carries a session id", async () => {
    const { calls, fetcher } = fakeFetch(toolsListReply);
    const sessions: McpSessions = new Map();

    expect(await listMcpTools(SERVER, fetcher, sessions)).toEqual([SEARCH]);

    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(
      calls.every((call) => headerOf(call, "Mcp-Session-Id") === null)
    ).toBe(true);
    expect(sessions.has(URL_)).toBe(true);
    expect(await sessions.get(URL_)).toBeUndefined();
  });

  test("a 400 from a stateless server is an error, not a retry", async () => {
    const { calls, fetcher } = fakeFetch((body) =>
      body.method === "tools/call"
        ? new Response("bad", { status: 400 })
        : toolsListReply(body)
    );

    await expect(
      registrationWith(fetcher, new Map()).execute({}, NO_API, CONTEXT)
    ).rejects.toThrow("MCP tools/call failed: 400");
    expect(callsTo(calls, "tools/call")).toHaveLength(1);
    expect(callsTo(calls, "initialize")).toHaveLength(1);
  });
});

/**
 * A fake stateful server that keys each tools/call by its request id, as the MCP
 * SDK does. A repeated id replaces the earlier resolver, so that request never answers.
 */
const keyedServer = () => {
  const pending = new Map<number | undefined, (response: Response) => void>();
  const calls: Call[] = [];
  const fetcher: McpFetch = (url, init) => {
    const body: RpcRequest = JSON.parse(String(init.body));
    calls.push({ body, init, url });
    if (body.method === "initialize") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: { protocolVersion: "2025-06-18" },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Mcp-Session-Id": "session-1",
            },
          }
        )
      );
    }
    if (body.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    const { id } = body;
    const { arguments: args } = body.params as { arguments: { q: string } };
    return new Promise<Response>((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => {
        const answer = pending.get(id);
        pending.delete(id);
        answer?.(
          Response.json({
            id,
            jsonrpc: "2.0",
            result: { content: [{ text: `echo:${args.q}`, type: "text" }] },
          })
        );
      }, 0);
    });
  };
  return { calls, fetcher };
};

const RESOLVE_LIMIT_MS = 1000;

/** `work`, or a rejection after RESOLVE_LIMIT_MS, so a hang fails the test fast. */
const withinLimit = <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`no reply within ${RESOLVE_LIMIT_MS} ms: a request hung`)
        ),
      RESOLVE_LIMIT_MS
    );
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
};

describe("parallel tools/call on one server", () => {
  test("four parallel calls each get the reply meant for them, with distinct ids", async () => {
    const server = keyedServer();
    const registration = at(
      mcpToolRegistrations(
        "s",
        [SEARCH],
        () => Promise.resolve(SERVER),
        server.fetcher,
        undefined,
        new Map()
      ),
      0
    );
    const words = ["one", "two", "three", "four"];

    const results = await withinLimit(
      Promise.all(
        words.map((q) => registration.execute({ q }, NO_API, CONTEXT))
      )
    );

    expect(results.map((result) => result.output)).toEqual(
      words.map((word) => [{ text: `echo:${word}`, type: "text" }])
    );
    const ids = callsTo(server.calls, "tools/call").map((call) => call.body.id);
    expect(ids).toHaveLength(words.length);
    expect(new Set(ids).size).toBe(words.length);
  });
});

describe("mcpToolOrigins", () => {
  test("names each Pi tool after its server and tool, as the registrations do", () => {
    const tools: ServerTools = {
      "my server": [
        { ...SEARCH, name: "list.items/v2" },
        { ...SEARCH, name: "list items v2" },
      ],
      s: [SEARCH],
    };
    const registered = Object.entries(tools).flatMap(([key, listed]) =>
      mcpToolRegistrations(key, listed, () => Promise.resolve(SERVER)).map(
        (registration) => registration.name
      )
    );
    const origins = mcpToolOrigins(tools);

    expect([...origins.keys()].sort()).toEqual(registered.sort());
    expect(origins.get("my_server_list_items_v2")).toEqual({
      name: "list.items/v2",
      readOnly: true,
      server: "my server",
    });
    // The second tool collides with the first and gets a number.
    expect(origins.get("my_server_list_items_v2_2")).toEqual({
      name: "list items v2",
      readOnly: true,
      server: "my server",
    });
    expect(origins.get("s_search")).toEqual({
      name: "search",
      readOnly: true,
      server: "s",
    });
  });

  test("marks a tool read-only only when readOnlyHint is true", () => {
    const origins = mcpToolOrigins({
      s: [
        { ...SEARCH, name: "hinted" },
        { ...SEARCH, annotations: { readOnlyHint: false }, name: "denied" },
        { ...SEARCH, annotations: undefined, name: "bare" },
      ],
    });

    expect(origins.get("s_hinted")?.readOnly).toBe(true);
    expect(origins.get("s_denied")?.readOnly).toBe(false);
    expect(origins.get("s_bare")?.readOnly).toBe(false);
  });
});

describe("mcpToolRegistrations", () => {
  const registrationOf = (
    serverKey: string,
    tool: McpTool,
    fetcher: McpFetch = fakeFetch(() => jsonReply({ content: [] })).fetcher
  ): ToolRegistration =>
    at(
      mcpToolRegistrations(
        serverKey,
        [tool],
        () => Promise.resolve(SERVER),
        fetcher
      ),
      0
    );

  test("prefixes the name with the server key", () => {
    expect(registrationOf("github", SEARCH).name).toBe("github_search");
  });

  test("replaces characters outside [A-Za-z0-9_-] with underscores", () => {
    const registration = registrationOf("my server", {
      ...SEARCH,
      name: "list.items/v2",
    });

    expect(registration.name).toBe("my_server_list_items_v2");
  });

  test("cuts the name to 64 characters", () => {
    expect(registrationOf("a".repeat(60), SEARCH).name).toBe(
      `${"a".repeat(60)}_sea`
    );
    expect(registrationOf("b".repeat(80), SEARCH).name).toHaveLength(64);
  });

  test("replay is safe only when readOnlyHint is true", () => {
    const replayOf = (annotations?: McpTool["annotations"]) =>
      registrationOf("s", { ...SEARCH, annotations }).replay;

    expect(replayOf({ readOnlyHint: true })).toBe("safe");
    expect(replayOf({ readOnlyHint: false })).toBe("unsafe");
    expect(replayOf()).toBe("unsafe");
  });

  test("execute sends tools/call with the arguments and returns output text", async () => {
    const { calls, fetcher } = fakeFetch(() =>
      jsonReply({
        content: [
          { text: "first", type: "text" },
          { data: "AAAA", mimeType: "image/png", type: "image" },
        ],
      })
    );
    const registration = registrationOf("s", SEARCH, fetcher);

    const result = await registration.execute({ q: "x" }, NO_API, CONTEXT);

    expect(result).toEqual({
      isError: false,
      output: [{ text: "first\n[image]", type: "text" }],
    });
    const toolCall = at(callsTo(calls, "tools/call"), 0);
    expect(toolCall.body).toEqual({
      id: expect.any(Number),
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { q: "x" }, name: "search" },
    });
    expect(headerOf(toolCall, "Authorization")).toBe("Bearer first");
  });

  test("execute reports isError from the result", async () => {
    const { fetcher } = fakeFetch(() =>
      jsonReply({ content: [{ text: "bad", type: "text" }], isError: true })
    );
    const registration = registrationOf("s", SEARCH, fetcher);

    const result = await registration.execute({}, NO_API, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.output).toEqual([{ text: "bad", type: "text" }]);
  });

  test("getServer is read on every call, so a changed token is sent", async () => {
    let token = "first";
    const getServer = (): Promise<McpServerEntry> =>
      Promise.resolve({
        headers: { Authorization: `Bearer ${token}` },
        type: "http",
        url: URL_,
      });
    const { calls, fetcher } = fakeFetch(() => jsonReply({ content: [] }));
    const registration = at(
      mcpToolRegistrations("s", [SEARCH], getServer, fetcher),
      0
    );

    await registration.execute({}, NO_API, CONTEXT);
    token = "second";
    await registration.execute({}, NO_API, CONTEXT);

    const toolCalls = callsTo(calls, "tools/call");
    expect(headerOf(at(toolCalls, 0), "Authorization")).toBe("Bearer first");
    expect(headerOf(at(toolCalls, 1), "Authorization")).toBe("Bearer second");
  });

  test("the abort signal of the context reaches the fetch init", async () => {
    const { calls, fetcher } = fakeFetch(() => jsonReply({ content: [] }));
    const registration = registrationOf("s", SEARCH, fetcher);
    const controller = new AbortController();

    await registration.execute({}, NO_API, {
      ...CONTEXT,
      abortSignal: controller.signal,
    });

    const { signal } = at(callsTo(calls, "tools/call"), 0).init;
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});

/**
 * A fake server that answers every request except tools/call, which never answers.
 * It rejects when the call's signal aborts, or at once if the signal already has.
 */
const neverAnswersCall: McpFetch = (_url, init) => {
  const body: RpcRequest = JSON.parse(String(init.body));
  if (body.method !== "tools/call") {
    return Promise.resolve(toolsListReply(body));
  }
  return new Promise<Response>((_resolve, reject) => {
    const fail = (): void => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    if (init.signal?.aborted === true) {
      fail();
    }
    init.signal?.addEventListener("abort", fail);
  });
};

const TIME_LIMIT_MS = 20;

describe("call time limit", () => {
  test("a call that outlasts the limit returns a result the model can read", async () => {
    const onCallError: string[] = [];
    const registration = at(
      mcpToolRegistrations(
        "s",
        [SEARCH],
        () => Promise.resolve(SERVER),
        neverAnswersCall,
        () => onCallError.push("called"),
        new Map(),
        TIME_LIMIT_MS
      ),
      0
    );

    const result = await registration.execute({}, NO_API, CONTEXT);

    expect(result).toEqual({
      isError: true,
      output: [
        {
          text: "s search timed out after 0.02 s. Try a smaller request or retry.",
          type: "text",
        },
      ],
    });
    expect(onCallError).toEqual([]);
  });

  test("a caller abort during the call still rejects and skips onCallError", async () => {
    const onCallError: string[] = [];
    const registration = at(
      mcpToolRegistrations(
        "s",
        [SEARCH],
        () => Promise.resolve(SERVER),
        neverAnswersCall,
        () => onCallError.push("called"),
        new Map()
      ),
      0
    );
    const controller = new AbortController();

    const running = registration.execute({}, NO_API, {
      ...CONTEXT,
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(running).rejects.toThrow("aborted");
    expect(onCallError).toEqual([]);
  });
});

/** The text of a message's content, as the model reads it. */
const textOf = (content: Message["content"] | undefined): string => {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
};

const PROBE_SERVER = "probe";
const PROBE_TOOL = `${PROBE_SERVER}_search`;
const MCP_TEXT = "mcp-result-pinned";

/** Calls the tool, then repeats whatever text the tool result carried. */
const script = (context: TranscriptContext): AssistantMessage => {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([fauxText(`saw:${textOf(last.content)}`)]);
  }
  return fauxAssistantMessage([fauxToolCall(PROBE_TOOL, {})], {
    stopReason: "toolUse",
  });
};

/** The text the model read back from the tool result, through a real harness. */
const modelSawFrom = async (
  registration: ToolRegistration
): Promise<string> => {
  const faux = fauxProvider();
  faux.setResponses([script, script]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install({ name: PROBE_SERVER, tools: [registration] });

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT
  );
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { modelId: faux.getModel().id, provider: faux.provider.id },
    },
  });
  const submission = await root.submit(
    { content: "go", type: "input" },
    BACKGROUND_CONTEXT
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== "done") {
    throw new Error(`the run did not finish: ${settled.status}`);
  }

  const page = await root.entries(
    { order: "ascending" },
    50,
    undefined,
    BACKGROUND_CONTEXT
  );
  await harness.close(BACKGROUND_CONTEXT);
  const toolResult = page.items
    .map((entry) => entry.model?.[0])
    .find((message) => message?.role === "toolResult");
  return textOf(toolResult?.content);
};

describe("MCP tool through pi-durable", () => {
  test("the model sees the text of an MCP tool result", async () => {
    const { fetcher } = fakeFetch(() =>
      jsonReply({ content: [{ text: MCP_TEXT, type: "text" }] })
    );
    const registration = at(
      mcpToolRegistrations(
        PROBE_SERVER,
        [SEARCH],
        () => Promise.resolve(SERVER),
        fetcher
      ),
      0
    );

    expect(await modelSawFrom(registration)).toBe(MCP_TEXT);
  });

  test("a call the proxy stopped at its limit lets the run carry on to the model's next turn", async () => {
    const message =
      "the-brain search timed out after 60 s. Try a smaller request or retry.";
    const onCallError: string[] = [];
    const { fetcher } = fakeFetch(() =>
      Response.json({
        error: { code: -32_000, data: { code: "timeout" }, message },
        id: 1,
        jsonrpc: "2.0",
      })
    );
    const registration = at(
      mcpToolRegistrations(
        PROBE_SERVER,
        [SEARCH],
        () => Promise.resolve(SERVER),
        fetcher,
        () => onCallError.push("called")
      ),
      0
    );

    expect(await modelSawFrom(registration)).toBe(message);
    expect(onCallError).toEqual([]);
  });

  test("a call past its time limit lets the run carry on to the model's next turn", async () => {
    const registration = at(
      mcpToolRegistrations(
        PROBE_SERVER,
        [SEARCH],
        () => Promise.resolve(SERVER),
        neverAnswersCall,
        undefined,
        new Map(),
        TIME_LIMIT_MS
      ),
      0
    );

    expect(await modelSawFrom(registration)).toBe(
      "probe search timed out after 0.02 s. Try a smaller request or retry."
    );
  });
});
describe("tool names that collide after the cut", () => {
  test("get a number, and stay within 64 characters", () => {
    const long = "t".repeat(80);
    const tools = [
      { inputSchema: {}, name: `${long}a` },
      { inputSchema: {}, name: `${long}b` },
      { inputSchema: {}, name: `${long}c` },
    ];
    const names = mcpToolRegistrations("server", tools, () =>
      Promise.reject(new Error("not called"))
    ).map((registration) => registration.name);

    expect(new Set(names).size).toBe(3);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names[1]?.endsWith("_2")).toBe(true);
    expect(names[2]?.endsWith("_3")).toBe(true);
  });
});

const UP_URL = "https://up.example.test/mcp";
const DOWN_URL = "https://down.example.test/mcp";
const OTHER_DOWN_URL = "https://other.example.test/mcp";
const OLD_TOOL: McpTool = { inputSchema: {}, name: "old" };
const GAP_MS = 1000;
const LATER_MS = 10_000;

/** A fetch that answers UP_URL and fails every other URL with its own message. */
const routedFetch: McpFetch = (url, init) => {
  if (url === UP_URL) {
    return Promise.resolve(
      toolsListReply(JSON.parse(String(init.body)) as RpcRequest)
    );
  }
  const message = url === DOWN_URL ? "first down" : "second down";
  return Promise.reject(new Error(message));
};

describe("syncMcpTools", () => {
  const up = { ...SERVER, url: UP_URL };
  const down = { ...SERVER, url: DOWN_URL };

  test("a down server keeps its known tools and reports it", async () => {
    const downs: [string, unknown][] = [];

    const tools = await syncMcpTools(
      { down, up },
      { down: [OLD_TOOL] },
      routedFetch,
      (key, error) => downs.push([key, error])
    );

    expect(tools).toEqual({ down: [OLD_TOOL], up: [SEARCH] });
    expect(downs.map(([key]) => key)).toEqual(["down"]);
    expect(downs[0]?.[1]).toBeInstanceOf(Error);
  });

  test("a down server with no known tools is left out", async () => {
    const downs: string[] = [];

    const tools = await syncMcpTools({ down, up }, {}, routedFetch, (key) =>
      downs.push(key)
    );

    expect(tools).toEqual({ up: [SEARCH] });
    expect(downs).toEqual(["down"]);
  });

  test("a known server that is no longer configured is not in the result", async () => {
    const tools = await syncMcpTools({ up }, { gone: [OLD_TOOL] }, routedFetch);

    expect(tools).toEqual({ up: [SEARCH] });
  });

  test("throws the first failure when no server is usable", async () => {
    const other = { ...SERVER, url: OTHER_DOWN_URL };

    await expect(
      syncMcpTools({ down, other }, {}, routedFetch)
    ).rejects.toThrow("first down");
  });

  test("an empty server map gives an empty result", async () => {
    expect(await syncMcpTools({}, { gone: [OLD_TOOL] }, routedFetch)).toEqual(
      {}
    );
  });
});

describe("toolChanges", () => {
  test("lists added servers to install", () => {
    expect(toolChanges({}, { a: [SEARCH] })).toEqual({
      install: ["a"],
      uninstall: [],
    });
  });

  test("lists a server whose tools changed to install", () => {
    expect(toolChanges({ a: [SEARCH] }, { a: [OLD_TOOL] })).toEqual({
      install: ["a"],
      uninstall: [],
    });
  });

  test("leaves an unchanged server out of both lists", () => {
    const same: ServerTools = { a: [SEARCH] };

    expect(toolChanges(same, { a: [{ ...SEARCH }] })).toEqual({
      install: [],
      uninstall: [],
    });
  });

  test("lists removed servers to uninstall", () => {
    expect(
      toolChanges({ a: [SEARCH], b: [OLD_TOOL] }, { a: [SEARCH] })
    ).toEqual({ install: [], uninstall: ["b"] });
  });
});

describe("throttled", () => {
  /** Lets pending promise callbacks run. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Work that stays in flight until `finish` is called. */
  const pendingWork = () => {
    let starts = 0;
    let finish: () => void = () => undefined;
    const work = (): Promise<void> => {
      starts += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    return { finish: () => finish(), starts: () => starts, work };
  };

  test("does not start while the last work is still in flight", async () => {
    const clock = { t: 0 };
    const job = pendingWork();
    const run = throttled(job.work, { minGapMs: GAP_MS, now: () => clock.t });

    run();
    clock.t = LATER_MS;
    run();

    expect(job.starts()).toBe(1);
    job.finish();
    await flush();
    clock.t = LATER_MS * 2;
    run();
    expect(job.starts()).toBe(2);
  });

  test("does not start again before the gap has passed", async () => {
    const clock = { t: 0 };
    const job = pendingWork();
    const run = throttled(job.work, { minGapMs: GAP_MS, now: () => clock.t });

    run();
    job.finish();
    await flush();
    clock.t = GAP_MS - 1;
    run();
    expect(job.starts()).toBe(1);

    clock.t = GAP_MS;
    run();
    expect(job.starts()).toBe(2);
  });

  test("a rejecting work does not throw, is logged, and does not block later runs", async () => {
    const clock = { t: 0 };
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const run = throttled(() => Promise.reject(new Error("refresh broke")), {
        minGapMs: GAP_MS,
        now: () => clock.t,
      });

      expect(() => run()).not.toThrow();
      await flush();
      expect(logged).toEqual([["MCP refresh failed", "refresh broke"]]);

      clock.t = LATER_MS;
      run();
      await flush();
      expect(logged).toHaveLength(2);
    } finally {
      console.error = original;
    }
  });
});

describe("onCallError", () => {
  const failing: McpFetch = () => Promise.reject(new Error("network down"));

  const registrationWith = (
    fetcher: McpFetch,
    onCallError: () => void
  ): ToolRegistration =>
    at(
      mcpToolRegistrations(
        "s",
        [SEARCH],
        () => Promise.resolve(SERVER),
        fetcher,
        onCallError
      ),
      0
    );

  test("is called when the server answers with a JSON-RPC error", async () => {
    const { fetcher } = fakeFetch(() =>
      Response.json({ error: { message: "gone" }, id: 1, jsonrpc: "2.0" })
    );
    let calls = 0;
    const registration = registrationWith(fetcher, () => {
      calls += 1;
    });

    await expect(registration.execute({}, NO_API, CONTEXT)).rejects.toThrow(
      "gone"
    );
    expect(calls).toBe(1);
  });

  test("is called when the HTTP request fails", async () => {
    let calls = 0;
    const registration = registrationWith(failing, () => {
      calls += 1;
    });

    await expect(registration.execute({}, NO_API, CONTEXT)).rejects.toThrow(
      "network down"
    );
    expect(calls).toBe(1);
  });

  test("is not called when the result has isError set", async () => {
    const { fetcher } = fakeFetch(() =>
      jsonReply({ content: [{ text: "bad", type: "text" }], isError: true })
    );
    let calls = 0;
    const registration = registrationWith(fetcher, () => {
      calls += 1;
    });

    const result = await registration.execute({}, NO_API, CONTEXT);

    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test("is not called when the call was aborted", async () => {
    let calls = 0;
    const registration = registrationWith(failing, () => {
      calls += 1;
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      registration.execute({}, NO_API, {
        ...CONTEXT,
        abortSignal: controller.signal,
      })
    ).rejects.toThrow("network down");
    expect(calls).toBe(0);
  });
});
