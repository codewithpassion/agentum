/** biome-ignore-all lint/suspicious/useAwait: Async boundary fixtures retain production port signatures. */
/** biome-ignore-all lint/performance/noAwaitInLoops: Sequential lifecycle cases mutate isolated authority and resource fixtures. */
import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { deckPrintHTML, documentPrintHTML } from "@repo/live-export";
import {
  assets,
  deckFixture,
  docFixture,
} from "../../../../../packages/live-export/src/fixtures/content";
import { exportPrintPDF } from "../browser-run";
import { type PrintSession, printPDF } from "./pdf";

const pagePattern = /\/Type \/Page\b/g;
test("production print lifecycle with actual local Chrome yields document and two-slide PDFs with no network", async () => {
  let closes = 0;
  const requests: string[] = [];
  const render = printPDF(async () => {
    const browser = await chromium.launch({
      args: ["--no-sandbox"],
      executablePath: "/usr/bin/google-chrome",
      headless: true,
    });
    const page = await browser.newPage({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    page.on("request", (request) => {
      requests.push(request.url());
    });
    return {
      close: async () => {
        closes += 1;
        await browser.close();
      },
      page,
    };
  });
  for (const [html, pages] of [
    [(await documentPrintHTML(docFixture(100), assets)).value, 0],
    [(await deckPrintHTML(deckFixture(), assets)).value, 2],
  ] as const) {
    const bytes = await render(html, new AbortController().signal);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    const count = text.match(pagePattern)?.length ?? 0;
    if (pages) {
      expect(count).toBe(pages);
    } else {
      expect(count).toBeGreaterThan(1);
    }
  }
  expect(closes).toBe(2);
  expect(requests).toEqual([]);
}, 30_000);

test("Browser Run adapter uses supplied binding and ephemeral no-JS context, blocks requests and closes on success/failure/abort", async () => {
  for (const fail of ["none", "content", "pdf", "abort", "newPage"] as const) {
    const controller = new AbortController();
    const events: unknown[] = [];
    const binding = {} as Env["BROWSER"];
    const page: PrintSession["page"] = {
      emulateMedia: async (options) => {
        events.push(options);
      },
      pdf: async (options) => {
        events.push(options);
        if (fail === "pdf") {
          throw new Error("print failure");
        }
        if (fail === "abort") {
          controller.abort();
        }
        return new TextEncoder().encode("%PDF-fixture");
      },
      route: async (pattern, handler) => {
        events.push(pattern);
        await handler({
          abort: async () => {
            events.push("blocked");
          },
        });
      },
      setContent: async (_html, options) => {
        events.push(options);
        if (fail === "content") {
          throw new Error("content failure");
        }
      },
    };
    let closes = 0;
    const render = exportPrintPDF(binding, async (received) => {
      expect(Object.is(received, binding)).toBe(true);
      return {
        close: async () => {
          closes += 1;
        },
        newPage: async (options) => {
          expect(options).toEqual({
            javaScriptEnabled: false,
            serviceWorkers: "block",
          });
          if (fail === "newPage") {
            throw new Error("open failure");
          }
          return page;
        },
      };
    });
    if (fail === "none") {
      expect(
        new TextDecoder().decode(await render("<p>safe</p>", controller.signal))
      ).toBe("%PDF-fixture");
      expect(events).toContain("blocked");
      expect(events).toContainEqual({
        displayHeaderFooter: false,
        preferCSSPageSize: true,
        printBackground: true,
        timeout: 20_000,
      });
    } else {
      await expect(
        render("<p>safe</p>", controller.signal)
      ).rejects.toBeDefined();
    }
    expect(closes).toBe(1);
  }
});

test("late browser acquisition after cancellation is closed without printing", async () => {
  const controller = new AbortController();
  let closes = 0;
  const render = printPDF(async () => {
    controller.abort();
    return {
      close: async () => {
        closes += 1;
      },
      page: {} as PrintSession["page"],
    };
  });
  await expect(render("<p>x</p>", controller.signal)).rejects.toBeDefined();
  expect(closes).toBe(1);
});
