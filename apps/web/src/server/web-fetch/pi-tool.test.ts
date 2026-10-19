import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type {
  Extension,
  PromptInput,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  NETWORK_TOOLS_EXTENSION,
  networkToolsExtension,
  type SecretPlaceholder,
} from "./pi-tool.ts";
import type { WebFetcher, WebFetchRequest, WebFetchResult } from "./types.ts";

/** A request as the tool sends it, with the signal the tool adds when the run has one. */
type SentRequest = WebFetchRequest & { signal?: AbortSignal };

// The web_fetch tool never reads the API, so the tests pass an empty one.
const NO_API = {} as ToolExecutionApi;
const NO_PROMPT = {} as PromptInput;
const contextWith = (abortSignal?: AbortSignal): Context => ({
  abortSignal,
  toString: () => "test-context",
  value: () => undefined,
});

const OFF_LINE =
  "Network access is off for this agent, so web_fetch and curl are not available.";

const okAnswer = (
  overrides: Partial<Extract<WebFetchResult, { ok: true }>> = {}
): WebFetchResult => ({
  bytes: new TextEncoder().encode("hello"),
  durationMs: 5,
  headers: { "content-type": "text/plain" },
  ok: true,
  status: 200,
  statusText: "OK",
  url: "https://example.com/",
  ...overrides,
});

/** A fake fetcher that records each request and answers with `answer`. */
const fakeFetcher = (answer: WebFetchResult = okAnswer()) => {
  const sent: SentRequest[] = [];
  const fetcher: WebFetcher = (request) => {
    sent.push(request);
    return Promise.resolve(answer);
  };
  return { fetcherOf: () => Promise.resolve(fetcher), sent };
};

const webFetchOf = (fetcherOf: () => Promise<WebFetcher>): ToolRegistration => {
  const tool = networkToolsExtension({ enabled: true, fetcherOf }).tools?.[0];
  if (tool === undefined) {
    throw new Error("the enabled extension has no tool");
  }
  return tool;
};

const textOf = (result: { output?: readonly unknown[] }): string => {
  const [item] = result.output ?? [];
  if (
    typeof item !== "object" ||
    item === null ||
    !("text" in item) ||
    typeof item.text !== "string"
  ) {
    throw new Error("the result has no text item");
  }
  return item.text;
};

describe("networkToolsExtension when network access is off", () => {
  const extension: Extension = networkToolsExtension({
    enabled: false,
    fetcherOf: () => Promise.reject(new Error("the fetcher must not run")),
  });

  test("has the extension name and no tools", () => {
    expect(extension.name).toBe(NETWORK_TOOLS_EXTENSION);
    expect(extension.name).toBe("hm-network-tools");
    expect(extension.tools).toEqual([]);
  });

  test("its one section renders exactly the off line", () => {
    const [section] = extension.sections ?? [];
    if (section === undefined) {
      throw new Error("the disabled extension has no section");
    }

    expect(section.render(NO_PROMPT, contextWith())).toBe(OFF_LINE);
  });
});

describe("networkToolsExtension when network access is on", () => {
  test("has exactly one tool, web_fetch, and no section", () => {
    const extension = networkToolsExtension({
      enabled: true,
      fetcherOf: () => Promise.reject(new Error("not called")),
    });

    expect(extension.name).toBe(NETWORK_TOOLS_EXTENSION);
    expect(extension.tools?.map((tool) => tool.name)).toEqual(["web_fetch"]);
    expect(extension.sections).toBeUndefined();
  });

  test("the tool is not safe to replay, because a POST may not run twice", () => {
    const tool = webFetchOf(() => Promise.reject(new Error("not called")));

    expect(tool.replay).toBe("unsafe");
  });

  test("a GET sends the URL and returns the answer as JSON", async () => {
    const { fetcherOf, sent } = fakeFetcher();
    const tool = webFetchOf(fetcherOf);

    const result = await tool.execute(
      { url: "https://example.com/" },
      NO_API,
      contextWith()
    );

    expect(sent).toEqual([{ method: "GET", url: "https://example.com/" }]);
    expect(result.isError).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual({
      body: "hello",
      bytes: 5,
      encoding: "text",
      headers: { "content-type": "text/plain" },
      status: 200,
      statusText: "OK",
      url: "https://example.com/",
    });
  });

  test("method and headers pass through", async () => {
    const { fetcherOf, sent } = fakeFetcher();
    const tool = webFetchOf(fetcherOf);

    await tool.execute(
      {
        headers: { accept: "application/json" },
        method: "PATCH",
        url: "https://example.com/items/1",
      },
      NO_API,
      contextWith()
    );

    expect(sent).toEqual([
      {
        headers: { accept: "application/json" },
        method: "PATCH",
        url: "https://example.com/items/1",
      },
    ]);
  });

  test("a text body reaches the fetcher as its UTF-8 bytes", async () => {
    const { fetcherOf, sent } = fakeFetcher();
    const tool = webFetchOf(fetcherOf);

    await tool.execute(
      { body: "héllo ✓", method: "POST", url: "https://example.com/" },
      NO_API,
      contextWith()
    );

    expect(sent[0]?.body).toEqual(new TextEncoder().encode("héllo ✓"));
  });

  test("a base64 body reaches the fetcher as the decoded bytes", async () => {
    const { fetcherOf, sent } = fakeFetcher();
    const tool = webFetchOf(fetcherOf);

    await tool.execute(
      {
        body: Buffer.from([0, 255, 1, 128]).toString("base64"),
        bodyEncoding: "base64",
        method: "PUT",
        url: "https://example.com/",
      },
      NO_API,
      contextWith()
    );

    expect(sent[0]?.body).toEqual(new Uint8Array([0, 255, 1, 128]));
  });

  test("an invalid base64 body is an error and the fetcher does not run", async () => {
    const { fetcherOf, sent } = fakeFetcher();
    const tool = webFetchOf(fetcherOf);

    const result = await tool.execute(
      {
        body: "not base64!",
        bodyEncoding: "base64",
        url: "https://example.com/",
      },
      NO_API,
      contextWith()
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("web_fetch failed (bad_request)");
    expect(sent).toEqual([]);
  });

  test("a binary answer comes back base64 encoded when responseEncoding is base64", async () => {
    const raw = new Uint8Array([0, 200, 255, 10, 13]);
    const { fetcherOf } = fakeFetcher(okAnswer({ bytes: raw }));
    const tool = webFetchOf(fetcherOf);

    const result = await tool.execute(
      { responseEncoding: "base64", url: "https://example.com/image.png" },
      NO_API,
      contextWith()
    );
    const answer = JSON.parse(textOf(result));

    expect(answer.encoding).toBe("base64");
    expect(answer.bytes).toBe(raw.length);
    expect(Uint8Array.from(atob(answer.body), (c) => c.charCodeAt(0))).toEqual(
      raw
    );
  });

  test("a UTF-8 answer is decoded as text", async () => {
    const { fetcherOf } = fakeFetcher(
      okAnswer({ bytes: new TextEncoder().encode("grüße ✓") })
    );
    const tool = webFetchOf(fetcherOf);

    const result = await tool.execute(
      { url: "https://example.com/" },
      NO_API,
      contextWith()
    );

    expect(JSON.parse(textOf(result)).body).toBe("grüße ✓");
  });

  test("a failed fetch is an error with the message, and no header or body values", async () => {
    const { fetcherOf } = fakeFetcher({
      error: "blocked",
      message: "Address 10.0.0.1 is private",
      ok: false,
    });
    const tool = webFetchOf(fetcherOf);

    const result = await tool.execute(
      {
        body: "secret-body-value",
        headers: { authorization: "Bearer secret-token-value" },
        method: "POST",
        url: "http://10.0.0.1/",
      },
      NO_API,
      contextWith()
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "web_fetch failed (blocked): Address 10.0.0.1 is private"
    );
    expect(textOf(result)).not.toContain("secret-token-value");
    expect(textOf(result)).not.toContain("secret-body-value");
  });

  test("the run's abort signal reaches the fetcher", async () => {
    const { fetcherOf, sent } = fakeFetcher();
    const tool = webFetchOf(fetcherOf);
    const controller = new AbortController();

    await tool.execute(
      { url: "https://example.com/" },
      NO_API,
      contextWith(controller.signal)
    );

    expect(sent[0]?.signal).toBe(controller.signal);
  });
});

const PLACEHOLDER_LEAD =
  "Some secrets are available to you as placeholders. Write the placeholder text where the value belongs, in a web_fetch url, header value or text body, or in a curl command in the bash tool, where the variable $NAME holds the placeholder. The platform fills in the real value as the request leaves, and only for the hosts listed. You cannot read the real value.";

/** The rendered placeholder section, or undefined when the extension has none. */
const placeholderTextOf = async (
  placeholders: readonly SecretPlaceholder[]
): Promise<string | undefined> => {
  const extension = networkToolsExtension({
    enabled: true,
    fetcherOf: () => Promise.reject(new Error("not called")),
    placeholdersOf: () => Promise.resolve(placeholders),
  });
  const section = extension.sections?.find(
    (candidate) => candidate.key === "secret-placeholders"
  );
  if (section === undefined) {
    throw new Error("the enabled extension has no placeholder section");
  }
  return await section.render(NO_PROMPT, contextWith());
};

describe("networkToolsExtension placeholder section", () => {
  test("lists each name, its placeholder text and its hosts, and no value", async () => {
    const text = await placeholderTextOf([
      { hosts: ["api.github.com", "uploads.github.com"], name: "GITHUB_TOKEN" },
      { hosts: ["api.example.com"], name: "EXAMPLE_KEY" },
    ]);

    expect(text).toBe(
      `${PLACEHOLDER_LEAD}\n\n` +
        "- EXAMPLE_KEY (placeholder hm-secret:EXAMPLE_KEY): sent only to api.example.com\n" +
        "- GITHUB_TOKEN (placeholder hm-secret:GITHUB_TOKEN): sent only to api.github.com, uploads.github.com"
    );
  });

  test("a secret without hosts says it cannot be used yet", async () => {
    const text = await placeholderTextOf([{ hosts: [], name: "NEW_KEY" }]);

    expect(text).toBe(
      `${PLACEHOLDER_LEAD}\n\n` +
        "- NEW_KEY (placeholder hm-secret:NEW_KEY): no allowed hosts yet, so it cannot be used until someone adds them under Settings, Secrets"
    );
  });

  test("lines are sorted by name whatever order the list comes in", async () => {
    const text = await placeholderTextOf([
      { hosts: ["b.example"], name: "ZETA" },
      { hosts: ["a.example"], name: "ALPHA" },
      { hosts: ["m.example"], name: "MID" },
    ]);
    const lines = (text ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- "));

    expect(lines.map((line) => line.split(" ")[1])).toEqual([
      "ALPHA",
      "MID",
      "ZETA",
    ]);
  });

  test("an empty list renders nothing, so the prompt gets no section", async () => {
    expect(await placeholderTextOf([])).toBeUndefined();
  });

  test("when network access is off, the notice is still the only section and placeholders are not read", () => {
    const extension = networkToolsExtension({
      enabled: false,
      fetcherOf: () => Promise.reject(new Error("not called")),
      placeholdersOf: () => Promise.reject(new Error("must not be read")),
    });

    expect(extension.sections?.map((section) => section.key)).toEqual([
      "network-access",
    ]);
    expect(extension.tools).toEqual([]);
  });

  test("the web_fetch description says placeholder text is replaced for allowed hosts", () => {
    const tool = webFetchOf(() => Promise.reject(new Error("not called")));

    expect(tool.description).toContain(
      "Text of the form hm-secret:NAME in the url, a header value or a text body is replaced by that secret's value when the host is one the secret allows."
    );
  });
});
