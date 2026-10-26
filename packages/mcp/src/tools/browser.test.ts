import { describe, expect, test } from "bun:test";
import type { BrowserPort, PortFailure } from "../ports";
import { runSafely, toolResult } from "../result";
import { browserTools } from "./browser";

const snapshot = {
  links: [{ href: "https://example.com/docs", text: "Docs" }],
  linksTruncated: false,
  text: "hello",
  textTruncated: false,
  title: "Example",
  url: "https://example.com",
};
const port = (overrides: Partial<BrowserPort> = {}): BrowserPort => ({
  click: async () => ({ ok: true, snapshot }),
  fill: async () => ({ ok: true, selector: "#q", url: snapshot.url }),
  navigate: async () => ({ ok: true, snapshot }),
  screenshot: async () => ({
    image: { data: "aGk=", mimeType: "image/png" },
    ok: true,
    pageUrl: snapshot.url,
    url: "https://app.example/shot.png",
  }),
  snapshot: async () => ({ ok: true, snapshot }),
  ...overrides,
});
const call = (browser: BrowserPort, name: string, input: unknown = {}) => {
  const tool = browserTools({ browser }).find((item) => item.name === name);
  if (!tool) {
    throw new Error(name);
  }
  return runSafely(async () => tool.run(tool.inputSchema.parse(input)));
};
describe("browser tools", () => {
  test("only available with a port; only snapshot is read-only", () => {
    expect(browserTools({})).toEqual([]);
    const tools = browserTools({ browser: port() });
    expect(tools.map((tool) => tool.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_fill",
      "browser_screenshot",
    ]);
    expect(
      tools
        .filter((tool) => tool.annotations.readOnlyHint)
        .map((tool) => tool.name)
    ).toEqual(["browser_snapshot"]);
  });
  test("forwards inputs and returns summaries, full snapshots and fill acknowledgement", async () => {
    const received: unknown[] = [];
    const browser = port({
      click: (input) => {
        received.push(input);
        return Promise.resolve({ ok: true, snapshot });
      },
      fill: (input) => {
        received.push(input);
        return Promise.resolve({
          ok: true,
          selector: input.selector,
          url: snapshot.url,
        });
      },
      navigate: (input) => {
        received.push(input);
        return Promise.resolve({ ok: true, snapshot });
      },
    });
    expect(
      (await call(browser, "browser_navigate", { url: snapshot.url }))
        .structuredContent
    ).toMatchObject({
      summary: expect.stringContaining("hello"),
      title: "Example",
      url: snapshot.url,
    });
    expect(
      (await call(browser, "browser_click", { selector: "#go" }))
        .structuredContent
    ).toMatchObject({ summary: expect.stringContaining("browser_snapshot") });
    expect(
      (await call(browser, "browser_fill", { selector: "#q", value: "query" }))
        .structuredContent
    ).toEqual({ filled: "#q", url: snapshot.url });
    expect((await call(browser, "browser_snapshot")).structuredContent).toEqual(
      snapshot
    );
    expect(received).toEqual([
      { url: snapshot.url },
      { selector: "#go" },
      { selector: "#q", value: "query" },
    ]);
  });
  test("screenshots include an MCP image and link, ordinary payloads stay text-only", async () => {
    const result = await call(port(), "browser_screenshot");
    expect(result.content).toContainEqual({
      data: "aGk=",
      mimeType: "image/png",
      type: "image",
    });
    expect(result.structuredContent).toMatchObject({
      markdown: expect.stringContaining("shot.png"),
      pageUrl: snapshot.url,
      url: "https://app.example/shot.png",
    });
    expect(toolResult({ data: {}, text: "ok" }).content).toEqual([
      { text: "ok", type: "text" },
    ]);
  });
  test("rejects non-http URLs and bounds selector and fill arguments", async () => {
    await Promise.all(
      ["file:///etc/passwd", "javascript:alert(1)", "relative", ""].map(
        async (url) => {
          expect(
            (await call(port(), "browser_navigate", { url })).isError
          ).toBe(true);
        }
      )
    );
    await Promise.all(
      ["", "x".repeat(4001)].map(async (selector) => {
        expect(
          (await call(port(), "browser_click", { selector })).isError
        ).toBe(true);
      })
    );
    expect(
      (
        await call(port(), "browser_fill", {
          selector: "#q",
          value: "x".repeat(500_001),
        })
      ).isError
    ).toBe(true);
  });
  test("all operations translate every typed failure", async () => {
    await Promise.all(
      (
        [
          "offline",
          "desktop_unavailable",
          "desktop_busy",
          "human_in_control",
          "timeout",
        ] as const
      ).map(async (code) => {
        const failure: PortFailure = { code, ok: false };
        const browser = port({
          click: async () => failure,
          fill: async () => failure,
          navigate: async () => failure,
          screenshot: async () => failure,
          snapshot: async () => failure,
        });
        await Promise.all(
          (
            [
              ["browser_navigate", { url: snapshot.url }],
              ["browser_snapshot", {}],
              ["browser_click", { selector: "#a" }],
              ["browser_fill", { selector: "#a", value: "" }],
              ["browser_screenshot", {}],
            ] as const
          ).map(async ([name, input]) => {
            const result = await call(browser, name, input);
            expect(result.isError).toBe(true);
            expect(JSON.stringify(result.content)).toContain(code);
          })
        );
      })
    );
  });
});
