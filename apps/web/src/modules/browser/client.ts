import type { Db } from "#/db/client";
import { logActivity } from "#/modules/activity/service";
import {
  summarizeClick,
  summarizeFill,
  summarizeNavigate,
  summarizeScreenshot,
} from "./activity";
import { validateFillValue, validateSelector, validateUrl } from "./rules";
import { getSession, saveSession, storeScreenshot } from "./service";
import {
  type PageOutcome,
  runClick,
  runFill,
  runNavigate,
  runScreenshot,
  runSnapshot,
} from "./session";
import { buildSnapshot, type PageSnapshot, snapshotDetail } from "./snapshot";
import {
  BROWSER_UNAVAILABLE,
  type ClickResult,
  type FillResult,
  type NavigateResult,
  type ScreenshotResult,
  type SnapshotResult,
} from "./types";

/**
 * The internal face of an agent's browser. MCP tools and the `/api` routes both
 * go through here, so URL rules, the session bookkeeping and the activity log
 * are applied exactly once, and `@cloudflare/playwright` stays behind
 * `session.ts`.
 */
export interface AgentBrowserClient {
  click: (selector: string) => Promise<ClickResult>;
  fill: (selector: string, value: string) => Promise<FillResult>;
  navigate: (url: string) => Promise<NavigateResult>;
  screenshot: () => Promise<ScreenshotResult>;
  snapshot: () => Promise<SnapshotResult>;
}

const BLANK_PAGE = "about:blank";
const NOTHING_OPEN =
  "No page is open yet. Use browser_navigate to open one first.";
const ERROR_MAX_LENGTH = 400;

/**
 * Playwright errors carry a full call log after the first line. The first line
 * is the part an agent can act on.
 */
const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const [first = ""] = message.split("\n");
  return first.slice(0, ERROR_MAX_LENGTH) || BROWSER_UNAVAILABLE;
};

export const createBrowserClient = (
  db: Db,
  env: Env,
  workspace: { slug: string },
  agentId: string
): AgentBrowserClient => {
  /** The session id to try to resume, or null to start a new browser. */
  const lastSessionId = async (): Promise<string | null> =>
    (await getSession(db, agentId))?.sessionId ?? null;

  /**
   * Every operation records where the browser now is, whether or not it moved -
   * that timestamp is also what the status endpoint reads as "still open".
   */
  const remember = async (outcome: PageOutcome): Promise<PageSnapshot> => {
    const snapshot = buildSnapshot(outcome.raw);
    await saveSession(db, {
      agentId,
      currentUrl: snapshot.url === BLANK_PAGE ? null : snapshot.url,
      sessionId: outcome.sessionId,
    });
    return snapshot;
  };

  return {
    async click(selector) {
      const target = validateSelector(selector);
      if (!target.ok) {
        return target;
      }
      if (!env.BROWSER) {
        return { ok: false, reason: BROWSER_UNAVAILABLE };
      }

      let snapshot: PageSnapshot;
      try {
        snapshot = await remember(
          await runClick(env.BROWSER, await lastSessionId(), target.value)
        );
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }

      await logActivity(db, {
        agentId,
        detail: { selector: target.value, ...snapshotDetail(snapshot) },
        kind: "browser.click",
        summary: summarizeClick({
          selector: target.value,
          url: snapshot.url,
        }),
      });
      return { ok: true, snapshot };
    },

    async fill(selector, value) {
      const target = validateSelector(selector);
      if (!target.ok) {
        return target;
      }
      const text = validateFillValue(value);
      if (!text.ok) {
        return text;
      }
      if (!env.BROWSER) {
        return { ok: false, reason: BROWSER_UNAVAILABLE };
      }

      let snapshot: PageSnapshot;
      try {
        snapshot = await remember(
          await runFill(
            env.BROWSER,
            await lastSessionId(),
            target.value,
            text.value
          )
        );
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }

      await logActivity(db, {
        agentId,
        // The value itself is never recorded: an agent filling a login form
        // would otherwise write a password into a table the UI renders.
        detail: {
          selector: target.value,
          url: snapshot.url,
          valueLength: text.value.length,
        },
        kind: "browser.fill",
        summary: summarizeFill({ selector: target.value, url: snapshot.url }),
      });
      return { ok: true, selector: target.value, url: snapshot.url };
    },

    async navigate(url) {
      const target = validateUrl(url);
      if (!target.ok) {
        return target;
      }
      if (!env.BROWSER) {
        return { ok: false, reason: BROWSER_UNAVAILABLE };
      }

      let snapshot: PageSnapshot;
      try {
        snapshot = await remember(
          await runNavigate(env.BROWSER, await lastSessionId(), target.url)
        );
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }

      await logActivity(db, {
        agentId,
        detail: snapshotDetail(snapshot),
        kind: "browser.navigate",
        summary: summarizeNavigate({
          title: snapshot.title,
          url: snapshot.url,
        }),
      });
      return { ok: true, snapshot };
    },

    async screenshot() {
      if (!env.BROWSER) {
        return { ok: false, reason: BROWSER_UNAVAILABLE };
      }

      let outcome: Awaited<ReturnType<typeof runScreenshot>>;
      try {
        outcome = await runScreenshot(env.BROWSER, await lastSessionId());
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }

      const snapshot = await remember(outcome);
      if (snapshot.url === BLANK_PAGE) {
        return { ok: false, reason: NOTHING_OPEN };
      }

      const stored = await storeScreenshot(db, env.ATTACHMENTS, {
        agentId,
        bytes: outcome.bytes,
        pageUrl: snapshot.url,
        title: snapshot.title,
        workspaceSlug: workspace.slug,
      });
      await logActivity(db, {
        agentId,
        detail: {
          screenshotId: stored.id,
          screenshotUrl: stored.url,
          size: stored.size,
          title: stored.title,
          url: stored.pageUrl,
        },
        kind: "browser.screenshot",
        summary: summarizeScreenshot({ url: snapshot.url }),
      });
      return { ok: true, screenshot: stored };
    },

    async snapshot() {
      if (!env.BROWSER) {
        return { ok: false, reason: BROWSER_UNAVAILABLE };
      }

      let snapshot: PageSnapshot;
      try {
        snapshot = await remember(
          await runSnapshot(env.BROWSER, await lastSessionId())
        );
      } catch (error) {
        return { ok: false, reason: describe(error) };
      }

      // Reading a blank page is not an error, but "nothing is open" is more use
      // to an agent than an empty snapshot of about:blank.
      if (snapshot.url === BLANK_PAGE) {
        return { ok: false, reason: NOTHING_OPEN };
      }
      return { ok: true, snapshot };
    },
  };
};
