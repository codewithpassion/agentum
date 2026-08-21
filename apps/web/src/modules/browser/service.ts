import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import { encodeActivityCursor } from "#/modules/activity/service";
import { deleteObjects } from "#/r2";
import { isSessionStale, screenshotKey } from "./rules";
import {
  type BrowserScreenshot,
  type BrowserSession,
  browserScreenshots,
  browserSessions,
} from "./schema";
import type { BrowserStatus, StoredScreenshot } from "./types";

/**
 * D1 for the agent browser: which session an agent has open, and the
 * screenshots it has taken. The screenshot bytes live in R2 - `storeScreenshot`
 * writes both, in that order, so a row never points at an object that is not
 * there.
 *
 * Cursors are the activity feed's `(createdAt, id)` pair, encoded by that
 * module's helpers: both lists are read newest-first by the same right rail,
 * and one cursor format is enough.
 */

const NONCE_BYTES = 4;
const HEX_RADIX = 16;
const BYTE_HEX_LENGTH = 2;

const nonce = (): string => {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => byte.toString(HEX_RADIX).padStart(BYTE_HEX_LENGTH, "0"))
    .join("");
};

export const getSession = async (
  db: Db,
  agentId: string
): Promise<BrowserSession | null> => {
  const [row] = await db
    .select()
    .from(browserSessions)
    .where(eq(browserSessions.agentId, agentId))
    .limit(1);
  return row ?? null;
};

/** One row per agent: the newest session simply replaces the last. */
export const saveSession = async (
  db: Db,
  input: { agentId: string; currentUrl: string | null; sessionId: string }
): Promise<void> => {
  const updatedAt = new Date();
  await db
    .insert(browserSessions)
    .values({ ...input, updatedAt })
    .onConflictDoUpdate({
      set: {
        currentUrl: input.currentUrl,
        sessionId: input.sessionId,
        updatedAt,
      },
      target: browserSessions.agentId,
    });
};

/**
 * Neither browser table has a foreign key to `agents`, so the workspace-delete
 * cleanup removes them by hand - the screenshots' R2 keys first, since the rows
 * that name them are about to go.
 */
export const deleteBrowserDataForAgents = async (
  db: Db,
  bucket: R2Bucket,
  agentIds: readonly string[]
): Promise<void> => {
  if (agentIds.length === 0) {
    return;
  }
  const ids = [...agentIds];
  const stored = await db
    .select({ r2Key: browserScreenshots.r2Key })
    .from(browserScreenshots)
    .where(inArray(browserScreenshots.agentId, ids));
  await db
    .delete(browserScreenshots)
    .where(inArray(browserScreenshots.agentId, ids));
  await db.delete(browserSessions).where(inArray(browserSessions.agentId, ids));
  await deleteObjects(
    bucket,
    stored.map((row) => row.r2Key)
  );
};

export const screenshotUrl = (
  workspaceSlug: string,
  agentId: string,
  screenshotId: string
): string =>
  `/api/w/${workspaceSlug}/agents/${agentId}/browser/screenshots/${screenshotId}`;

const TRAILING_SLASHES = /\/+$/;

/**
 * The same path an agent can paste into a message or a wiki page. Relative is
 * right for the UI and useless in chat, so tools resolve it against
 * `PUBLIC_APP_URL` - falling back to the request's origin, as the MCP URL
 * builder does.
 */
export const absoluteUrl = (
  publicAppUrl: string | undefined,
  requestUrl: string,
  path: string
): string => {
  const base = publicAppUrl || new URL(requestUrl).origin;
  return `${base.replace(TRAILING_SLASHES, "")}${path}`;
};

export const toScreenshotView = (
  workspaceSlug: string,
  row: BrowserScreenshot
): StoredScreenshot => ({
  createdAt: row.createdAt.getTime(),
  id: row.id,
  pageUrl: row.pageUrl,
  size: row.size,
  title: row.title,
  url: screenshotUrl(workspaceSlug, row.agentId, row.id),
});

/** R2 first, then the row that indexes it. */
export const storeScreenshot = async (
  db: Db,
  bucket: R2Bucket,
  input: {
    agentId: string;
    bytes: Uint8Array;
    pageUrl: string;
    title: string;
    /** The agent's workspace, for the URL the screenshot is addressed by. */
    workspaceSlug: string;
  }
): Promise<StoredScreenshot> => {
  const createdAt = new Date();
  const key = screenshotKey(input.agentId, createdAt.getTime(), nonce());
  await bucket.put(key, input.bytes, {
    httpMetadata: { contentType: "image/png" },
  });

  const row: BrowserScreenshot = {
    agentId: input.agentId,
    createdAt,
    id: crypto.randomUUID(),
    pageUrl: input.pageUrl,
    r2Key: key,
    size: input.bytes.byteLength,
    title: input.title,
  };
  await db.insert(browserScreenshots).values(row);
  return toScreenshotView(input.workspaceSlug, row);
};

export const getScreenshot = async (
  db: Db,
  screenshotId: string
): Promise<BrowserScreenshot | null> => {
  const [row] = await db
    .select()
    .from(browserScreenshots)
    .where(eq(browserScreenshots.id, screenshotId))
    .limit(1);
  return row ?? null;
};

/** Newest first, the order the right rail reads them in. */
export const listScreenshots = async (
  db: Db,
  options: {
    agentId: string;
    cursor?: { createdAt: number; id: string };
    limit: number;
    workspaceSlug: string;
  }
): Promise<{ nextCursor: string | null; screenshots: StoredScreenshot[] }> => {
  const { agentId, cursor, limit } = options;
  const cursorCondition = cursor
    ? or(
        lt(browserScreenshots.createdAt, new Date(cursor.createdAt)),
        and(
          eq(browserScreenshots.createdAt, new Date(cursor.createdAt)),
          lt(browserScreenshots.id, cursor.id)
        )
      )
    : undefined;

  const rows = await db
    .select()
    .from(browserScreenshots)
    .where(and(eq(browserScreenshots.agentId, agentId), cursorCondition))
    .orderBy(desc(browserScreenshots.createdAt), desc(browserScreenshots.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    nextCursor: rows.length > limit && last ? encodeActivityCursor(last) : null,
    screenshots: page.map((row) =>
      toScreenshotView(options.workspaceSlug, row)
    ),
  };
};

/**
 * What the right rail shows about the browser. "Active" is our best guess from
 * the last use: Browser Run closes idle sessions without telling us, and asking
 * it would cost a round trip on every poll.
 */
export const readStatus = async (
  db: Db,
  env: Env,
  agentId: string,
  now = Date.now()
): Promise<BrowserStatus> => {
  const session = await getSession(db, agentId);
  const lastUsedAt = session?.updatedAt.getTime() ?? null;
  return {
    available: Boolean(env.BROWSER),
    currentUrl: session?.currentUrl ?? null,
    lastUsedAt,
    sessionActive: lastUsedAt !== null && !isSessionStale(lastUsedAt, now),
  };
};
