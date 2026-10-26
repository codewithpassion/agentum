import type { RawSnapshot } from "./snapshot.ts";

/** An attached session. release disconnects without closing the remote browser. */
export interface BrowserPage {
  click: (selector: string) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  release: () => Promise<void>;
  screenshot: () => Promise<Uint8Array>;
  snapshot: () => Promise<RawSnapshot>;
}

/** The Playwright/Browser Run adapter lives outside services (V6.11). */
export interface BrowserDriver {
  connect: (sessionId: string) => Promise<BrowserPage>;
  launch: (options: { keepAliveMs: number }) => Promise<{
    page: BrowserPage;
    sessionId: string;
  }>;
}
