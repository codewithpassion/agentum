import {
  type Browser,
  type BrowserWorker,
  connect,
  launch,
  type Page,
  type WorkersConnectOptions,
  type WorkersLaunchOptions,
} from "@cloudflare/playwright";
import type { RawSnapshot } from "@repo/services/browser/snapshot";
import type { BrowserDriver, BrowserPage } from "@repo/services/browser/types";
import type {
  ArtifactTestBrowser,
  ArtifactTestPage,
} from "./artifact-test/driver.ts";

/**
 * The only place `@cloudflare/playwright` is imported. Browser Run is beta, so
 * everything above this file speaks in plain values: a `Page` never escapes it.
 *
 * `persistent: true` is load-bearing on both `launch` and `connect`. Without it
 * the reconnected browser reports zero contexts and the previous call's page is
 * unreachable. The option is not in the published option types, hence the two
 * local types.
 */

/**
 * The package types its endpoint as `{ fetch: typeof fetch }`, which the
 * generated `BrowserRun` binding type does not structurally satisfy. Only
 * `fetch` is ever called on it, so the two are the same thing in practice.
 */
const endpoint = (binding: Env["BROWSER"]): BrowserWorker =>
  binding as unknown as BrowserWorker;

type LaunchOptions = WorkersLaunchOptions & { persistent?: boolean };
type ConnectOptions = WorkersConnectOptions & { persistent?: boolean };

const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

/**
 * One tab per agent. The persistent context opens with a blank page already in
 * it, so reusing the first page keeps an agent from accumulating tabs it has no
 * way to switch between.
 */
const singlePage = async (browser: Browser): Promise<Page> => {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return context.pages()[0] ?? (await context.newPage());
};

/**
 * The page as text and links. `innerText` rather than the accessibility tree:
 * the tree's Playwright API is deprecated upstream, and rendered text plus
 * anchors is what an agent actually acts on.
 */
const readPage = async (page: Page): Promise<RawSnapshot> => {
  const [title, content] = await Promise.all([
    page.title(),
    page.evaluate(() => ({
      links: [...document.querySelectorAll("a[href]")].map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        text: anchor.textContent ?? "",
      })),
      text: document.body?.innerText ?? "",
    })),
  ]);
  return { links: content.links, text: content.text, title, url: page.url() };
};

/**
 * `release` differs by how the browser was obtained. In Playwright, `close()`
 * on a browser from `connect` only disconnects (the session stays alive for its
 * keep_alive), but on a browser from `launch` it ends the session. So a page
 * from `connect` closes its browser, and a page from `launch` leaves it open:
 * the connection ends with the request.
 */
const browserPage = (
  page: Page,
  release: () => Promise<void>
): BrowserPage => ({
  click: async (selector) => {
    await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    // A click that navigates leaves the load in flight; a snapshot taken
    // straight after would otherwise read the old page.
    await page.waitForLoadState("domcontentloaded", {
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  },
  fill: async (selector, value) => {
    await page.fill(selector, value, { timeout: ACTION_TIMEOUT_MS });
  },
  navigate: async (url) => {
    await page.goto(url, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
  },
  release,
  screenshot: async () => await page.screenshot({ type: "png" }),
  snapshot: async () => await readPage(page),
});

const keepSessionOpen = async (): Promise<void> => undefined;

export const browserRunDriver = (binding: Env["BROWSER"]): BrowserDriver => ({
  connect: async (sessionId) => {
    const options: ConnectOptions = { persistent: true, sessionId };
    // Throws when the session is gone; the service catches it and relaunches.
    const browser = await connect(endpoint(binding), options);
    return browserPage(await singlePage(browser), async () => {
      await browser.close();
    });
  },
  launch: async ({ keepAliveMs }) => {
    const options: LaunchOptions = {
      keep_alive: keepAliveMs,
      persistent: true,
    };
    const browser = await launch(endpoint(binding), options);
    return {
      page: browserPage(await singlePage(browser), keepSessionOpen),
      sessionId: browser.sessionId(),
    };
  },
});

const artifactTestPage = (page: Page): ArtifactTestPage => ({
  goto: async (url) => {
    await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
  },
  listen: (listeners) => {
    page.on("console", (message) => {
      listeners.console({ text: message.text(), type: message.type() });
    });
    page.on("pageerror", (error) => {
      listeners.pageError(error.message);
    });
    page.on("requestfailed", (request) => {
      listeners.requestFailed({
        method: request.method(),
        reason: request.failure()?.errorText ?? "failed",
        url: request.url(),
      });
    });
    page.on("response", (response) => {
      listeners.response({ status: response.status(), url: response.url() });
    });
  },
  screenshot: async () => await page.screenshot({ type: "png" }),
  settle: async (milliseconds) => {
    await page.waitForTimeout(milliseconds);
  },
  snapshot: async () => await readPage(page),
  title: async () => await page.title(),
});

/**
 * A throwaway browser per `artifact_test` run, at the run's viewport. `launch`
 * without `persistent` or `keep_alive`: `close()` ends the session, so nothing
 * outlives the call.
 */
export const artifactTestBrowser = (
  binding: Env["BROWSER"]
): ArtifactTestBrowser => ({
  open: async (viewport) => {
    const browser = await launch(endpoint(binding));
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return {
      close: async () => {
        await browser.close();
      },
      page: artifactTestPage(page),
    };
  },
});
