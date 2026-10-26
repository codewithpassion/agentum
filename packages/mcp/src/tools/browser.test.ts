import { describe, expect, test } from "bun:test";
import type { BrowserPort, PortFailure } from "../ports";
import { runSafely, toolResult } from "../result";
import { browserTools } from "./browser";

const snapshot = { title: "Example", url: "https://example.com", text: "hello", links: [{ href: "https://example.com/docs", text: "Docs" }], linksTruncated: false, textTruncated: false };
const port = (overrides: Partial<BrowserPort> = {}): BrowserPort => ({
 navigate: async () => ({ ok: true, snapshot }),
 snapshot: async () => ({ ok: true, snapshot }),
 click: async () => ({ ok: true, snapshot }),
 fill: async () => ({ ok: true, selector: "#q", url: snapshot.url }),
 screenshot: async () => ({ ok: true, image: { data: "aGk=", mimeType: "image/png" }, pageUrl: snapshot.url, url: "https://app.example/shot.png" }),
 ...overrides,
});
const call = (browser: BrowserPort, name: string, input: unknown = {}) => {
 const tool = browserTools({ browser }).find((item) => item.name === name);
 if (!tool) { throw new Error(name); }
 return runSafely(async () => tool.run(tool.inputSchema.parse(input)));
};
describe("browser tools", () => {
 test("only available with a port; only snapshot is read-only", () => {
  expect(browserTools({})).toEqual([]);
  const tools = browserTools({ browser: port() });
  expect(tools.map((tool) => tool.name)).toEqual(["browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_screenshot"]);
  expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(["browser_snapshot"]);
 });
 test("forwards inputs and returns summaries, full snapshots and fill acknowledgement", async () => {
  const received: unknown[] = [];
  const browser = port({ navigate: async (input) => { received.push(input); return { ok: true, snapshot }; }, click: async (input) => { received.push(input); return { ok: true, snapshot }; }, fill: async (input) => { received.push(input); return { ok: true, selector: input.selector, url: snapshot.url }; } });
  expect((await call(browser, "browser_navigate", { url: snapshot.url })).structuredContent).toMatchObject({ title: "Example", url: snapshot.url, summary: expect.stringContaining("hello") });
  expect((await call(browser, "browser_click", { selector: "#go" })).structuredContent).toMatchObject({ summary: expect.stringContaining("browser_snapshot") });
  expect((await call(browser, "browser_fill", { selector: "#q", value: "query" })).structuredContent).toEqual({ filled: "#q", url: snapshot.url });
  expect((await call(browser, "browser_snapshot")).structuredContent).toEqual(snapshot);
  expect(received).toEqual([{ url: snapshot.url }, { selector: "#go" }, { selector: "#q", value: "query" }]);
 });
 test("screenshots include an MCP image and link, ordinary payloads stay text-only", async () => {
  const result = await call(port(), "browser_screenshot");
  expect(result.content).toContainEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
  expect(result.structuredContent).toMatchObject({ pageUrl: snapshot.url, url: "https://app.example/shot.png", markdown: expect.stringContaining("shot.png") });
  expect(toolResult({ data: {}, text: "ok" }).content).toEqual([{ type: "text", text: "ok" }]);
 });
 test("rejects non-http URLs and bounds selector and fill arguments", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "relative", ""]) { expect((await call(port(), "browser_navigate", { url })).isError).toBe(true); }
  for (const selector of ["", "x".repeat(4001)]) { expect((await call(port(), "browser_click", { selector })).isError).toBe(true); }
  expect((await call(port(), "browser_fill", { selector: "#q", value: "x".repeat(500_001) })).isError).toBe(true);
 });
 test("all operations translate every typed failure", async () => {
  for (const code of ["offline", "desktop_unavailable", "desktop_busy", "human_in_control", "timeout"] as const) {
   const failure: PortFailure = { ok: false, code };
   const browser = port({ navigate: async () => failure, snapshot: async () => failure, click: async () => failure, fill: async () => failure, screenshot: async () => failure });
   for (const [name, input] of [["browser_navigate", { url: snapshot.url }], ["browser_snapshot", {}], ["browser_click", { selector: "#a" }], ["browser_fill", { selector: "#a", value: "" }], ["browser_screenshot", {}]] as const) {
    const result = await call(browser, name, input);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(code);
   }
  }
 });
});
