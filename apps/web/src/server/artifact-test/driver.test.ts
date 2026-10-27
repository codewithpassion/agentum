import { describe, expect, test } from "bun:test";
import {
  type ArtifactTestBrowser,
  type ArtifactTestPage,
  runArtifactTest,
  type TestPageListeners,
} from "./driver.ts";

interface FakeOptions {
  closed?: { value: boolean };
  emit?: (listeners: TestPageListeners) => void;
  gotoError?: Error;
  opened?: { height: number; width: number }[];
  settled?: number[];
}

const fakeBrowser = (options: FakeOptions = {}): ArtifactTestBrowser => ({
  open: (viewport) => {
    options.opened?.push(viewport);
    let listeners: TestPageListeners | undefined;
    const page: ArtifactTestPage = {
      goto: () => {
        if (listeners) {
          options.emit?.(listeners);
        }
        return options.gotoError
          ? Promise.reject(options.gotoError)
          : Promise.resolve();
      },
      listen: (next) => {
        listeners = next;
      },
      screenshot: () => Promise.resolve(new Uint8Array([137, 80, 78, 71])),
      settle: (milliseconds) => {
        options.settled?.push(milliseconds);
        return Promise.resolve();
      },
      snapshot: () =>
        Promise.resolve({
          links: [{ href: "https://example.com/", text: " Home " }],
          text: "Hello\n\n\n\nWorld",
          title: "Page",
          url: "https://app.test/a/1/c/hm_view_x.y/index.html",
        }),
    };
    return Promise.resolve({
      close: () => {
        if (options.closed) {
          options.closed.value = true;
        }
        return Promise.resolve();
      },
      page,
    });
  },
});

describe("runArtifactTest", () => {
  test("opens the desktop and phone viewports", async () => {
    const opened: { height: number; width: number }[] = [];
    const browser = fakeBrowser({ opened });
    await runArtifactTest({
      browser,
      url: "https://app.test/",
      viewport: "desktop",
    });
    await runArtifactTest({
      browser,
      url: "https://app.test/",
      viewport: "phone",
    });
    expect(opened).toEqual([
      { height: 800, width: 1280 },
      { height: 844, width: 390 },
    ]);
  });

  test("collects errors and warnings, drops other console types", async () => {
    const result = await runArtifactTest({
      browser: fakeBrowser({
        emit: (listeners) => {
          listeners.console({ text: "log line", type: "log" });
          listeners.console({
            text: "Refused to load script (CSP)",
            type: "error",
          });
          listeners.console({ text: "deprecated", type: "warning" });
          listeners.console({ text: "legacy warn", type: "warn" });
          listeners.console({ text: "info line", type: "info" });
          listeners.pageError("ReferenceError: nope is not defined");
        },
      }),
      url: "https://app.test/",
      viewport: "desktop",
    });
    expect(result.consoleEntries).toEqual([
      { level: "error", text: "Refused to load script (CSP)" },
      { level: "warning", text: "deprecated" },
      { level: "warning", text: "legacy warn" },
      { level: "error", text: "ReferenceError: nope is not defined" },
    ]);
  });

  test("collects failed requests and only 4xx/5xx responses", async () => {
    const result = await runArtifactTest({
      browser: fakeBrowser({
        emit: (listeners) => {
          listeners.requestFailed({
            method: "GET",
            reason: "net::ERR_BLOCKED_BY_CSP",
            url: "https://cdn.test/x.js",
          });
          listeners.response({ status: 200, url: "https://app.test/ok" });
          listeners.response({ status: 302, url: "https://app.test/moved" });
          listeners.response({
            status: 404,
            url: "https://app.test/missing.css",
          });
          listeners.response({ status: 500, url: "https://app.test/api" });
        },
      }),
      url: "https://app.test/",
      viewport: "phone",
    });
    expect(result.failedRequests).toHaveLength(1);
    expect(result.badResponses).toEqual([
      { status: 404, url: "https://app.test/missing.css" },
      { status: 500, url: "https://app.test/api" },
    ]);
  });

  test("returns title, built snapshot, screenshot and settles after load", async () => {
    const settled: number[] = [];
    const result = await runArtifactTest({
      browser: fakeBrowser({ settled }),
      url: "https://app.test/",
      viewport: "desktop",
    });
    expect(result.title).toBe("Page");
    expect(result.loadError).toBeUndefined();
    expect(result.snapshot.text).toBe("Hello\n\nWorld");
    expect(result.snapshot.links).toEqual([
      { href: "https://example.com/", text: "Home" },
    ]);
    expect([...result.screenshot]).toEqual([137, 80, 78, 71]);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBeGreaterThan(0);
  });

  test("a navigation failure is reported and the rest is still collected", async () => {
    const closed = { value: false };
    const result = await runArtifactTest({
      browser: fakeBrowser({
        closed,
        gotoError: new Error("Timeout 30000ms exceeded"),
      }),
      url: "https://app.test/",
      viewport: "desktop",
    });
    expect(result.loadError).toBe("Timeout 30000ms exceeded");
    expect(result.screenshot.byteLength).toBeGreaterThan(0);
    expect(closed.value).toBe(true);
  });

  test("closes the browser when collection throws", async () => {
    const closed = { value: false };
    const base = fakeBrowser({ closed });
    const browser: ArtifactTestBrowser = {
      open: async (viewport) => {
        const session = await base.open(viewport);
        return {
          close: session.close,
          page: {
            ...session.page,
            screenshot: () => Promise.reject(new Error("crashed")),
          },
        };
      },
    };
    await expect(
      runArtifactTest({
        browser,
        url: "https://app.test/",
        viewport: "desktop",
      })
    ).rejects.toThrow("crashed");
    expect(closed.value).toBe(true);
  });
});
