import { expect, test } from "bun:test";
import { ToolError } from "@repo/mcp/result";
import { ForbiddenError } from "@repo/services/authz";
import type { BrowserService } from "@repo/services/browser";
import { ServiceError } from "@repo/services/errors";
import type { Principal } from "@repo/services/workspaces";
import { createBrowserPorts } from "./browser-ports.ts";

const run: Principal = {
  agentId: "a",
  kind: "run",
  runId: "r",
  workspaceId: "w",
};

const snapshot = {
  links: [{ href: "https://example.com/next", text: "Next" }],
  linksTruncated: false,
  text: "Hello",
  textTruncated: false,
  title: "Example",
  url: "https://example.com/",
};

const portsOver = (browser: Record<string, unknown>) =>
  createBrowserPorts({
    principal: run,
    services: { browser } as unknown as { browser: BrowserService },
  });

test("navigate returns the snapshot and passes the run principal and url", async () => {
  const seen: unknown[] = [];
  const ports = portsOver({
    navigate: (who: unknown, url: unknown) => {
      seen.push(who, url);
      return Promise.resolve(snapshot);
    },
  });
  expect(await ports.navigate({ url: "https://example.com/" })).toEqual({
    ok: true,
    snapshot,
  });
  expect(seen).toEqual([run, "https://example.com/"]);
});

test("an invalid url becomes a validation failure", async () => {
  const ports = portsOver({
    navigate: () =>
      Promise.reject(new ServiceError("invalid", "Only public http(s) URLs.")),
  });
  expect(await ports.navigate({ url: "file:///etc/passwd" })).toEqual({
    code: "validation",
    ok: false,
    reason: "Only public http(s) URLs.",
  });
});

test("the browser being unavailable becomes an offline failure", async () => {
  const ports = portsOver({
    click: () =>
      Promise.reject(
        new ServiceError("conflict", "The browser is unavailable right now.")
      ),
  });
  expect(await ports.click({ selector: "#go" })).toEqual({
    code: "offline",
    ok: false,
    reason: "The browser is unavailable right now.",
  });
});

test("a not found error becomes a not_found failure", async () => {
  const ports = portsOver({
    fill: () => Promise.reject(new ServiceError("not_found", "No such field.")),
  });
  expect(await ports.fill({ selector: "#x", value: "v" })).toEqual({
    code: "not_found",
    ok: false,
    reason: "No such field.",
  });
});

test("screenshot returns base64 png and the page url, without a url key", async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const ports = portsOver({
    screenshot: () =>
      Promise.resolve({
        bytes,
        entry: { path: "task/screenshot.png" },
        pageUrl: "https://example.com/",
      }),
  });
  const result = await ports.screenshot();
  expect(result).toEqual({
    image: { data: "iVBORw==", mimeType: "image/png" },
    ok: true,
    pageUrl: "https://example.com/",
  });
  expect(result).not.toHaveProperty("url");
});

test("a forbidden browser call is rethrown as a forbidden tool error", async () => {
  const ports = portsOver({
    snapshot: () => Promise.reject(new ForbiddenError("browser.action")),
  });
  const error = await ports.snapshot().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe("forbidden");
});

test("fill returns the selector and the url", async () => {
  const seen: unknown[] = [];
  const ports = portsOver({
    fill: (who: unknown, selector: unknown, value: unknown) => {
      seen.push(who, selector, value);
      return Promise.resolve({
        selector: "#email",
        url: "https://example.com/",
      });
    },
  });
  expect(
    await ports.fill({ selector: "#email", value: "a@example.net" })
  ).toEqual({
    ok: true,
    selector: "#email",
    url: "https://example.com/",
  });
  expect(seen).toEqual([run, "#email", "a@example.net"]);
});
