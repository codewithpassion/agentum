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
  type McpTool,
  mcpToolRegistrations,
} from "./pi-run-mcp.ts";

type McpServerEntry = CloudStart["mcpServers"][string];

interface RpcRequest {
  id: number;
  jsonrpc: string;
  method: string;
  params: unknown;
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

describe("listMcpTools", () => {
  test("sends initialize then tools/list and returns the tools", async () => {
    const { calls, fetcher } = fakeFetch(toolsListReply);

    const tools = await listMcpTools(SERVER, fetcher);

    expect(tools).toEqual([SEARCH]);
    expect(calls.map((call) => call.body.method)).toEqual([
      "initialize",
      "tools/list",
    ]);
    expect(at(calls, 0).body.params).toEqual({
      capabilities: {},
      clientInfo: { name: "harbourmaster-cloud-runtime", version: "0" },
      protocolVersion: "2025-06-18",
    });
    expect(at(calls, 0).url).toBe(URL_);
    const headers = new Headers(at(calls, 1).init.headers);
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
    expect(at(calls, 0).body).toEqual({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { q: "x" }, name: "search" },
    });
    expect(new Headers(at(calls, 0).init.headers).get("Authorization")).toBe(
      "Bearer first"
    );
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

    expect(new Headers(at(calls, 0).init.headers).get("Authorization")).toBe(
      "Bearer first"
    );
    expect(new Headers(at(calls, 1).init.headers).get("Authorization")).toBe(
      "Bearer second"
    );
  });

  test("the abort signal of the context reaches the fetch init", async () => {
    const { calls, fetcher } = fakeFetch(() => jsonReply({ content: [] }));
    const registration = registrationOf("s", SEARCH, fetcher);
    const controller = new AbortController();

    await registration.execute({}, NO_API, {
      ...CONTEXT,
      abortSignal: controller.signal,
    });

    expect(at(calls, 0).init.signal).toBe(controller.signal);
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
});
