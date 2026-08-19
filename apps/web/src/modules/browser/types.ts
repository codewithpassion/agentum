import type { PageSnapshot } from "./snapshot";

/** The shapes the agent browser speaks in, shared by the client and its callers. */

/**
 * Shown whenever there is no browser to reach - no `BROWSER` binding in this
 * deployment, or Browser Run refused the session. The UI renders it as the
 * "browser unavailable - Retry" state rather than an error page, because the
 * next call may well succeed.
 */
export const BROWSER_UNAVAILABLE =
  "The browser is unavailable right now. Wait a moment and retry; every other tool still works.";

export type NavigateResult =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: false; reason: string };

export type SnapshotResult = NavigateResult;

export type ClickResult = NavigateResult;

export type FillResult =
  | { ok: true; selector: string; url: string }
  | { ok: false; reason: string };

export interface StoredScreenshot {
  createdAt: number;
  id: string;
  pageUrl: string;
  size: number;
  title: string;
  /** Relative to this app, the way attachments are addressed. */
  url: string;
}

export type ScreenshotResult =
  | { ok: true; screenshot: StoredScreenshot }
  | { ok: false; reason: string };

export interface BrowserStatus {
  /** False when this deployment has no browser binding at all. */
  available: boolean;
  currentUrl: string | null;
  lastUsedAt: number | null;
  /** A session we believe is still open, so the UI can say "browsing". */
  sessionActive: boolean;
}
