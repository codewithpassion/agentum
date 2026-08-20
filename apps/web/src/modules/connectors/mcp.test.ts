import { describe, expect, test } from "bun:test";
import { McpError, McpUnauthorizedError, probeMcpServer } from "./mcp";

/**
 * The MCP server is faked at the `fetch` boundary. What matters here is that a
 * 401 arrives as an `McpUnauthorizedError` still carrying `WWW-Authenticate` -
 * that header is what the OAuth ladder starts from.
 */

const URL_UNDER_TEST = "https://mcp.example.com/mcp";
const NO_SUCH_METHOD = /no such method/;
const PRIVATE_NETWORK = /private network/;

interface Sent {
  body: Record<string, unknown>;
  headers: Headers;
}

const recorder = (respond: (method: string) => Response) => {
  const sent: Sent[] = [];
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ body, headers: new Headers(init?.headers) });
    return Promise.resolve(respond(String(body.method)));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
};

const rpcResult = (result: unknown): Response =>
  Response.json({ id: 1, jsonrpc: "2.0", result });

const TOOLS = {
  tools: [
    { description: "Create an issue", name: "create_issue" },
    { name: "list_issues" },
    { description: "no name, dropped" },
  ],
};

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "linear" },
};

const standardServer = (method: string): Response => {
  if (method === "initialize") {
    return rpcResult(INITIALIZE);
  }
  if (method === "tools/list") {
    return rpcResult(TOOLS);
  }
  return new Response(null, { status: 202 });
};

describe("probeMcpServer", () => {
  test("initializes and lists tools", async () => {
    const { fetchImpl, sent } = recorder(standardServer);
    const probe = await probeMcpServer(URL_UNDER_TEST, { fetchImpl });

    expect(probe.serverName).toBe("linear");
    expect(probe.tools).toEqual([
      { description: "Create an issue", name: "create_issue" },
      { description: null, name: "list_issues" },
    ]);
    expect(sent.map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  test("sends the bearer token when one is given, and none when not", async () => {
    const authed = recorder(standardServer);
    await probeMcpServer(URL_UNDER_TEST, {
      fetchImpl: authed.fetchImpl,
      token: "tok_123",
    });
    expect(authed.sent[0]?.headers.get("authorization")).toBe("Bearer tok_123");

    const anonymous = recorder(standardServer);
    await probeMcpServer(URL_UNDER_TEST, { fetchImpl: anonymous.fetchImpl });
    expect(anonymous.sent[0]?.headers.get("authorization")).toBeNull();
  });

  test("carries the session id from initialize into later calls", async () => {
    const { fetchImpl, sent } = recorder((method) =>
      method === "initialize"
        ? new Response(JSON.stringify({ id: 1, result: INITIALIZE }), {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-42",
            },
          })
        : standardServer(method)
    );

    await probeMcpServer(URL_UNDER_TEST, { fetchImpl });

    expect(sent[0]?.headers.get("mcp-session-id")).toBeNull();
    expect(sent[2]?.headers.get("mcp-session-id")).toBe("sess-42");
  });

  test("reads an SSE-framed response", async () => {
    const sse = (payload: unknown) =>
      new Response(
        `event: message\ndata: ${JSON.stringify({ id: 1, result: payload })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      );
    const { fetchImpl } = recorder((method) => {
      if (method === "initialize") {
        return sse(INITIALIZE);
      }
      return method === "tools/list"
        ? sse(TOOLS)
        : new Response(null, { status: 202 });
    });

    const probe = await probeMcpServer(URL_UNDER_TEST, { fetchImpl });
    expect(probe.serverName).toBe("linear");
    expect(probe.tools).toHaveLength(2);
  });

  test("follows tools/list pagination", async () => {
    let page = 0;
    const { fetchImpl } = recorder((method) => {
      if (method === "initialize") {
        return rpcResult(INITIALIZE);
      }
      if (method !== "tools/list") {
        return new Response(null, { status: 202 });
      }
      page += 1;
      return page === 1
        ? rpcResult({ nextCursor: "p2", tools: [{ name: "one" }] })
        : rpcResult({ tools: [{ name: "two" }] });
    });

    const probe = await probeMcpServer(URL_UNDER_TEST, { fetchImpl });
    expect(probe.tools.map((tool) => tool.name)).toEqual(["one", "two"]);
  });

  test("turns a 401 into McpUnauthorizedError, keeping the challenge", async () => {
    const challenge =
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';
    const { fetchImpl } = recorder(
      () =>
        new Response("", {
          headers: { "www-authenticate": challenge },
          status: 401,
        })
    );

    expect(
      probeMcpServer(URL_UNDER_TEST, { fetchImpl })
    ).rejects.toBeInstanceOf(McpUnauthorizedError);

    const error = await probeMcpServer(URL_UNDER_TEST, { fetchImpl }).catch(
      (thrown: unknown) => thrown
    );
    expect((error as McpUnauthorizedError).wwwAuthenticate).toBe(challenge);
  });

  test("treats a 403 as an authorization prompt too", () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 403 }));
    expect(
      probeMcpServer(URL_UNDER_TEST, { fetchImpl })
    ).rejects.toBeInstanceOf(McpUnauthorizedError);
  });

  test("reports a server error with its status", async () => {
    const { fetchImpl } = recorder(
      () => new Response("upstream exploded", { status: 502 })
    );
    const error = (await probeMcpServer(URL_UNDER_TEST, { fetchImpl }).catch(
      (thrown: unknown) => thrown
    )) as McpError;

    expect(error).toBeInstanceOf(McpError);
    expect(error.status).toBe(502);
    expect(error.message).toContain("upstream exploded");
  });

  test("surfaces a JSON-RPC error frame", () => {
    const { fetchImpl } = recorder(() =>
      Response.json({ error: { message: "no such method" }, id: 1 })
    );
    expect(probeMcpServer(URL_UNDER_TEST, { fetchImpl })).rejects.toThrow(
      NO_SUCH_METHOD
    );
  });

  test("refuses a private URL before any request is made", () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response(""));
    }) as unknown as typeof fetch;

    expect(
      probeMcpServer("https://10.0.0.1/mcp", { fetchImpl })
    ).rejects.toThrow(PRIVATE_NETWORK);
    expect(called).toBe(false);
  });
});
