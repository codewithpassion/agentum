import {
  type Browser,
  type BrowserWorker,
  connect,
  launch,
  type Page,
  type WorkersConnectOptions,
  type WorkersLaunchOptions,
} from "@cloudflare/playwright";
import { KEEP_ALIVE_MS } from "./rules";
import type { RawSnapshot } from "./snapshot";

/**
 * The only place `@cloudflare/playwright` is imported. Browser Run is beta, and
 * the Kitesurf/Chromium choice below is the kind of thing that moves, so
 * everything above this file speaks in plain values: a `Page` never escapes it.
 *
 * Session reuse is what makes a browser usable over MCP at all. Each tool call
 * runs in a fresh Worker isolate, so "the page I navigated to last call" only
 * exists if we reconnect to the same Browser Run session - `launch()` acquires
 * one and hands back its id, `connect(binding, id)` picks it back up.
 *
 * `persistent: true` is load-bearing on both. Without it the reconnected
 * browser reports zero contexts and the previous call's page is unreachable;
 * with it the session's default context and its open pages come back. The
 * option is not in the published option types (the fork forwards unknown
 * options into the devtools URL it opens), hence the two local types.
 *
 * Kitesurf deliberately not used: `launch(binding, { browser: "kitesurf" })`
 * works, but it acquires no session at all (`sessionId()` is undefined), so
 * every tool call would get a brand new browser and clicking a link an earlier
 * call found would be impossible. Chromium through the same binding is the only
 * option here that keeps a page alive between calls.
 */

/**
 * The package types its endpoint as `{ fetch: typeof fetch }`, which the
 * generated `BrowserRun` binding type does not structurally satisfy - the
 * global `fetch` carries a `preconnect` property a binding has no reason to.
 * Only `fetch` is ever called on it, so the two are the same thing in practice.
 */
const endpoint = (binding: Env["BROWSER"]): BrowserWorker =>
  binding as unknown as BrowserWorker;

type LaunchOptions = WorkersLaunchOptions & { persistent?: boolean };
type ConnectOptions = WorkersConnectOptions & { persistent?: boolean };

const LAUNCH_OPTIONS: LaunchOptions = {
  keep_alive: KEEP_ALIVE_MS,
  persistent: true,
};

const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

interface OpenPage {
  page: Page;
  sessionId: string;
}

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
 * The agent's browser, reconnected if its last session is still alive and
 * launched fresh if not. A failed reconnect is expected - Browser Run closes
 * idle sessions - so it falls through rather than failing the tool call.
 */
const openPage = async (
  binding: Env["BROWSER"],
  existingSessionId: string | null
): Promise<OpenPage> => {
  if (existingSessionId) {
    const options: ConnectOptions = {
      persistent: true,
      sessionId: existingSessionId,
    };
    try {
      const browser = await connect(endpoint(binding), options);
      return { page: await singlePage(browser), sessionId: existingSessionId };
    } catch {
      // The session is gone, or the connection did not come back up. Either
      // way the agent gets a new browser instead of an error.
    }
  }

  const browser = await launch(endpoint(binding), LAUNCH_OPTIONS);
  return { page: await singlePage(browser), sessionId: browser.sessionId() };
};

/**
 * The page as text and links. `innerText` rather than the accessibility tree:
 * the tree's Playwright API is deprecated upstream and absent from parts of
 * this fork, and rendered text plus anchors is what an agent actually acts on.
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

/** Every operation ends by reading the page back: acting blind helps nobody. */
export interface PageOutcome {
  raw: RawSnapshot;
  sessionId: string;
}

export const runNavigate = async (
  binding: Env["BROWSER"],
  existingSessionId: string | null,
  url: string
): Promise<PageOutcome> => {
  const { page, sessionId } = await openPage(binding, existingSessionId);
  await page.goto(url, {
    timeout: NAVIGATION_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
  return { raw: await readPage(page), sessionId };
};

export const runSnapshot = async (
  binding: Env["BROWSER"],
  existingSessionId: string | null
): Promise<PageOutcome> => {
  const { page, sessionId } = await openPage(binding, existingSessionId);
  return { raw: await readPage(page), sessionId };
};

export const runClick = async (
  binding: Env["BROWSER"],
  existingSessionId: string | null,
  selector: string
): Promise<PageOutcome> => {
  const { page, sessionId } = await openPage(binding, existingSessionId);
  await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
  // A click that navigates leaves the load in flight; the snapshot below would
  // otherwise read the old page.
  await page.waitForLoadState("domcontentloaded", {
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  return { raw: await readPage(page), sessionId };
};

export const runFill = async (
  binding: Env["BROWSER"],
  existingSessionId: string | null,
  selector: string,
  value: string
): Promise<PageOutcome> => {
  const { page, sessionId } = await openPage(binding, existingSessionId);
  await page.fill(selector, value, { timeout: ACTION_TIMEOUT_MS });
  return { raw: await readPage(page), sessionId };
};

export interface ScreenshotOutcome extends PageOutcome {
  bytes: Uint8Array;
}

export const runScreenshot = async (
  binding: Env["BROWSER"],
  existingSessionId: string | null
): Promise<ScreenshotOutcome> => {
  const { page, sessionId } = await openPage(binding, existingSessionId);
  const bytes = await page.screenshot({ type: "png" });
  return { bytes, raw: await readPage(page), sessionId };
};
