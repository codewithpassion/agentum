import {
  buildSnapshot,
  type PageSnapshot,
  type RawSnapshot,
} from "@repo/services/browser/snapshot";

/**
 * The browser side of `artifact_test`: open a content URL at one viewport and
 * collect what broke. Everything here speaks in plain values. The Playwright
 * adapter that implements `ArtifactTestBrowser` lives in `../browser-run.ts`,
 * the only file that imports `@cloudflare/playwright`.
 *
 * Saving the screenshot to the task folder and setting the version's thumbnail
 * is the MCP adapter's job (A.6); this file returns the PNG bytes as data.
 */

export const ARTIFACT_TEST_VIEWPORTS = {
  desktop: { height: 800, width: 1280 },
  phone: { height: 844, width: 390 },
} as const;

export type ArtifactTestViewport = keyof typeof ARTIFACT_TEST_VIEWPORTS;

/** Time after the load event for scripts, fonts and late requests to land. */
const SETTLE_MS = 750;

export interface ConsoleEntry {
  level: "error" | "warning";
  text: string;
}

export interface FailedRequest {
  method: string;
  reason: string;
  url: string;
}

export interface BadResponse {
  status: number;
  url: string;
}

export interface TestPageListeners {
  console: (entry: { text: string; type: string }) => void;
  pageError: (message: string) => void;
  requestFailed: (request: FailedRequest) => void;
  response: (response: BadResponse) => void;
}

/** One tab at one viewport, as the driver needs it. */
export interface ArtifactTestPage {
  /** Resolves on the load event, rejects on a navigation failure or timeout. */
  goto: (url: string) => Promise<void>;
  listen: (listeners: TestPageListeners) => void;
  screenshot: () => Promise<Uint8Array>;
  settle: (milliseconds: number) => Promise<void>;
  snapshot: () => Promise<RawSnapshot>;
}

export interface ArtifactTestSession {
  close: () => Promise<void>;
  page: ArtifactTestPage;
}

export interface ArtifactTestBrowser {
  open: (viewport: {
    height: number;
    width: number;
  }) => Promise<ArtifactTestSession>;
}

export interface ArtifactTestResult {
  badResponses: BadResponse[];
  consoleEntries: ConsoleEntry[];
  failedRequests: FailedRequest[];
  /** Set when the navigation did not reach the load event. */
  loadError?: string;
  screenshot: Uint8Array;
  snapshot: PageSnapshot;
  title: string;
  viewport: ArtifactTestViewport;
}

const consoleLevel = (type: string): ConsoleEntry["level"] | null => {
  if (type === "error") {
    return "error";
  }
  return type === "warning" || type === "warn" ? "warning" : null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Load `url` in a fresh browser at the viewport, wait for load plus a short
 * settle, and return the console errors and warnings (CSP violations are
 * console errors in Chromium), failed requests, 4xx/5xx responses, the page
 * title, a text snapshot and a PNG. A navigation that fails or times out is
 * reported in `loadError` and the rest is collected from what rendered. If the
 * page can't be read at all afterwards, the call throws.
 */
export const runArtifactTest = async ({
  browser,
  url,
  viewport,
}: {
  browser: ArtifactTestBrowser;
  url: string;
  viewport: ArtifactTestViewport;
}): Promise<ArtifactTestResult> => {
  const session = await browser.open(ARTIFACT_TEST_VIEWPORTS[viewport]);
  try {
    const consoleEntries: ConsoleEntry[] = [];
    const failedRequests: FailedRequest[] = [];
    const badResponses: BadResponse[] = [];
    session.page.listen({
      console: ({ text, type }) => {
        const level = consoleLevel(type);
        if (level) {
          consoleEntries.push({ level, text });
        }
      },
      pageError: (message) => {
        consoleEntries.push({ level: "error", text: message });
      },
      requestFailed: (request) => {
        failedRequests.push(request);
      },
      response: (response) => {
        if (response.status >= 400) {
          badResponses.push(response);
        }
      },
    });

    let loadError: string | undefined;
    try {
      await session.page.goto(url);
    } catch (error) {
      loadError = errorMessage(error);
    }
    await session.page.settle(SETTLE_MS);

    const [snapshot, screenshot] = await Promise.all([
      session.page.snapshot(),
      session.page.screenshot(),
    ]);
    return {
      badResponses,
      consoleEntries,
      failedRequests,
      loadError,
      screenshot,
      snapshot: buildSnapshot(snapshot),
      title: snapshot.title,
      viewport,
    };
  } finally {
    await session.close();
  }
};
