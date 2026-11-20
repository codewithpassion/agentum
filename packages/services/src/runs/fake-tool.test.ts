import { describe, expect, test } from "bun:test";
import { type ProxyAccess, runTool, wantsTool } from "./fake-tool.ts";

/**
 * The connector proxy is faked at the `ProxyAccess.fetch` boundary. Each test
 * answers by JSON-RPC method, the way the real proxy would.
 */

const BASE_URL = "https://agentum.example";
const CONNECTOR = { id: "conn-1", name: "Docs" };
const RUN_TOKEN = "run-token";
const SESSION_ID = "sess-1";
const SEARCH_TOOL = {
  inputSchema: {
    properties: { query: { type: "string" } },
    required: ["query"],
    type: "object",
  },
  name: "search_docs",
};

interface RpcBody {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface Recorded {
  body: RpcBody;
  headers: Headers;
  url: string;
}

type Handler = (body: RpcBody) => Response;

const json = (value: unknown, status = 200, headers = {}): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });

const answer = (result: unknown): Response =>
  json({ id: 1, jsonrpc: "2.0", result }, 200, {
    "mcp-session-id": SESSION_ID,
  });

const NOT_FOUND = new Response("no route", { status: 500 });

/** A healthy server with one search tool. Overrides replace single methods. */
const healthy = (
  overrides: Partial<Record<string, () => Response>> = {}
): Handler => {
  const routes: Record<string, () => Response> = {
    initialize: () => answer({ serverInfo: { name: "docs" } }),
    "notifications/initialized": () => new Response(null, { status: 202 }),
    "tools/call": () =>
      answer({ content: [{ text: "invoice found", type: "text" }] }),
    "tools/list": () => answer({ tools: [SEARCH_TOOL] }),
    ...overrides,
  };
  return (body) => {
    const route = routes[body.method];
    return route ? route() : NOT_FOUND;
  };
};

const makeProxy = (handle: Handler) => {
  const requests: Recorded[] = [];
  const proxy: ProxyAccess = {
    baseUrl: BASE_URL,
    fetch: async (request) => {
      const body = (await request.json()) as RpcBody;
      requests.push({
        body,
        headers: request.headers,
        url: request.url,
      });
      return handle(body);
    },
  };
  return { proxy, requests };
};

const runWith = (text: string, handle: Handler) => {
  const { proxy, requests } = makeProxy(handle);
  return {
    requests,
    run: runTool({
      connectors: [CONNECTOR],
      proxy,
      runToken: RUN_TOKEN,
      text,
    }),
  };
};

const callParams = (requests: Recorded[]) =>
  requests.find((request) => request.body.method === "tools/call")?.body.params;

describe("runTool", () => {
  test("calls the first text-only tool and pairs the events", async () => {
    const { requests, run } = runWith("Find the invoice", healthy());
    const result = await run;

    expect(result.text).toBe("Used search_docs: invoice found");
    expect(callParams(requests)).toEqual({
      arguments: { query: "Find the invoice" },
      name: "search_docs",
    });

    for (const request of requests) {
      expect(request.url).toBe(`${BASE_URL}/api/proxy/${CONNECTOR.id}`);
      expect(request.headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    }
    expect(requests[0]?.headers.get("mcp-session-id")).toBeNull();
    for (const request of requests.slice(1)) {
      expect(request.headers.get("mcp-session-id")).toBe(SESSION_ID);
    }

    expect(result.events.map((event) => event.type)).toEqual([
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
    ]);
    expect(result.events[0]?.payload).toEqual({
      input: {},
      name: "tools/list",
      toolUseId: "fake-tool-1",
    });
    expect(result.events[1]?.payload).toEqual({
      ok: true,
      output: "search_docs",
      toolUseId: "fake-tool-1",
    });
    expect(result.events[2]?.payload).toEqual({
      input: { query: "Find the invoice" },
      name: "search_docs",
      toolUseId: "fake-tool-2",
    });
    expect(result.events[3]?.payload).toEqual({
      ok: true,
      output: "invoice found",
      toolUseId: "fake-tool-2",
    });
  });

  test("puts a needs_auth connect link in the reply", async () => {
    const link =
      "This connector needs your login. Open http://localhost:3917/connect/abc while signed in to Agentum to connect it.";
    const { run } = runWith(
      "Find the invoice",
      healthy({
        initialize: () =>
          json({
            error: {
              code: -32_001,
              data: { code: "needs_auth" },
              message: link,
            },
            id: 1,
            jsonrpc: "2.0",
          }),
      })
    );
    const result = await run;

    expect(result.text).toBe(`Docs could not be used: ${link}`);
    expect(result.events.map((event) => event.type)).toEqual([
      "tool.call",
      "tool.result",
    ]);
    expect(result.events[0]?.payload).toEqual({
      input: {},
      name: "initialize",
      toolUseId: "fake-tool-1",
    });
    expect(result.events[1]?.payload).toEqual({
      ok: false,
      output: `Docs could not be used: ${link}`,
      toolUseId: "fake-tool-1",
    });
  });

  test("refuses a named tool the proxy does not allow", async () => {
    const { requests, run } = runWith(
      "Find the invoice tool:secret_tool",
      healthy({
        "tools/call": () =>
          json({ error: "forbidden", reason: "tool_not_allowed" }, 403),
        "tools/list": () => answer({ tools: [] }),
      })
    );
    const result = await run;

    expect(result.text).toBe(
      "secret_tool is not on this agent's allowed tools, so the call was refused."
    );
    expect(callParams(requests)).toEqual({
      arguments: {},
      name: "secret_tool",
    });
    expect(result.events.at(-1)?.payload).toEqual({
      ok: false,
      output: result.text,
      toolUseId: "fake-tool-2",
    });
  });

  test("replies without events when no connector is assigned", async () => {
    const { proxy, requests } = makeProxy(healthy());
    const result = await runTool({
      connectors: [],
      proxy,
      runToken: RUN_TOKEN,
      text: "Find the invoice",
    });

    expect(result).toEqual({
      events: [],
      text: "No app is assigned to this agent, so there is no tool to call.",
    });
    expect(requests).toHaveLength(0);
  });

  test("reads an SSE answer", async () => {
    const sse = (value: unknown) =>
      new Response(
        `event: message\ndata: ${JSON.stringify({ id: 1, jsonrpc: "2.0", result: value })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      );
    const { run } = runWith(
      "Find the invoice",
      healthy({
        initialize: () => sse({ serverInfo: { name: "docs" } }),
        "tools/call": () =>
          sse({ content: [{ text: "from sse", type: "text" }] }),
        "tools/list": () => sse({ tools: [SEARCH_TOOL] }),
      })
    );
    const result = await run;

    expect(result.text).toBe("Used search_docs: from sse");
  });

  test("says the proxy could not be reached when fetch throws", async () => {
    const proxy: ProxyAccess = {
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(new TypeError("socket hang up")),
    };
    const result = await runTool({
      connectors: [CONNECTOR],
      proxy,
      runToken: RUN_TOKEN,
      text: "Find the invoice",
    });

    expect(result.text).toBe("The proxy could not be reached.");
    expect(result.events.at(-1)?.payload).toEqual({
      ok: false,
      output: "The proxy could not be reached.",
      toolUseId: "fake-tool-1",
    });
  });
});

describe("wantsTool", () => {
  test("is true for the fake-tool model", () => {
    expect(wantsTool("fake-tool", "hello")).toBe(true);
  });

  test("is true for a tool marker in the text", () => {
    expect(wantsTool("claude", "look it up tool:search_docs")).toBe(true);
  });

  test("is false otherwise", () => {
    expect(wantsTool("claude", "hello")).toBe(false);
  });
});
