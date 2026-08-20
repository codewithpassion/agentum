import { and, asc, desc, eq, like, or } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
  type MemberAuthorView,
  resolveMemberAuthors,
} from "#/modules/workspaces/authors";
import { validateWikiAsset } from "./asset-rules";
import {
  type WikiAsset,
  type WikiAuthor,
  type WikiPage,
  type WikiRevision,
  wikiAssets,
  wikiPages,
  wikiRevisions,
} from "./schema";
import { leafTitle, slugifyPath } from "./slug";

/**
 * The wiki is written by the human through `/api/wiki` and, from the MCP layer,
 * by agents. Nothing here knows about either transport: every mutation takes the
 * author identity as a plain value.
 */

/** R2 prefix; the bucket is shared with message attachments. */
const ASSET_KEY_PREFIX = "wiki/";

/**
 * Timestamps cross the wire as epoch milliseconds: a `Date` would arrive at the
 * client as a string. These view shapes are what `/api/wiki` returns.
 */
export interface WikiPageSummary {
  id: string;
  slug: string;
  title: string;
  updatedAt: number;
}

export interface WikiPageView extends WikiPageSummary {
  body: string;
  createdAt: number;
}

export interface WikiRevisionView {
  /**
   * Who wrote it, resolved through `workspace_members` - set for
   * `authorType: "user"`, null for an agent. The Clerk id stays stored.
   */
  author: MemberAuthorView | null;
  /** The agent id, or the workspace member id (`""` for a former member). */
  authorId: string;
  authorType: WikiAuthor["type"];
  body: string;
  createdAt: number;
  id: string;
  pageId: string;
  title: string;
}

export const toPageView = (page: WikiPage): WikiPageView => ({
  body: page.body,
  createdAt: page.createdAt.getTime(),
  id: page.id,
  slug: page.slug,
  title: page.title,
  updatedAt: page.updatedAt.getTime(),
});

/**
 * Revisions to views, with human authors resolved through the workspace's
 * members in one batched lookup. Both revision routes go through here, so a
 * Clerk id has no way out of the wiki.
 */
export const toRevisionViews = async (
  db: Db,
  workspaceId: string,
  revisions: readonly WikiRevision[]
): Promise<WikiRevisionView[]> => {
  const authors = await resolveMemberAuthors(
    db,
    workspaceId,
    revisions
      .filter((revision) => revision.authorType === "user")
      .map((revision) => revision.authorId)
  );

  return revisions.map((revision) => {
    const author =
      revision.authorType === "user"
        ? (authors.get(revision.authorId) ?? null)
        : null;
    return {
      author,
      authorId: author ? (author.memberId ?? "") : revision.authorId,
      authorType: revision.authorType,
      body: revision.body,
      createdAt: revision.createdAt.getTime(),
      id: revision.id,
      pageId: revision.pageId,
      title: revision.title,
    };
  });
};

export const listPages = async (
  db: Db,
  workspaceId: string
): Promise<WikiPageSummary[]> => {
  const rows = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      updatedAt: wikiPages.updatedAt,
    })
    .from(wikiPages)
    .where(eq(wikiPages.workspaceId, workspaceId))
    .orderBy(asc(wikiPages.title));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() }));
};

/** Slugs are unique per workspace now, so the workspace is half the address. */
export const getPageBySlug = async (
  db: Db,
  workspaceId: string,
  slug: string
): Promise<WikiPage | undefined> => {
  const [page] = await db
    .select()
    .from(wikiPages)
    .where(
      and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.slug, slug))
    );
  return page;
};

const LIKE_WILDCARDS = /[%_\\]/g;
const SEARCH_LIMIT = 20;

/**
 * Substring match over title and body. Deliberately not full-text: the wiki is
 * small, and this keeps the schema free of an FTS table to maintain.
 */
export const searchPages = async (
  db: Db,
  workspaceId: string,
  query: string
): Promise<WikiPageSummary[]> => {
  const pattern = `%${query.replace(LIKE_WILDCARDS, "\\$&")}%`;
  const rows = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      updatedAt: wikiPages.updatedAt,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspaceId, workspaceId),
        or(like(wikiPages.title, pattern), like(wikiPages.body, pattern))
      )
    )
    .orderBy(desc(wikiPages.updatedAt))
    .limit(SEARCH_LIMIT);
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() }));
};

export interface CreatePageInput {
  author: WikiAuthor;
  body: string;
  /** Defaults to a slug derived from the title. */
  slug?: string;
  title: string;
}

/**
 * A `/` in a title nests the page: `Ops/Runbooks` lives at `ops/runbooks` and is
 * called "Runbooks" there. Every writer goes through here - the HTTP routes and
 * the agents' `wiki_write` alike - so an address is derived in exactly one way.
 */
export const normalizeWrite = (input: {
  slug?: string;
  title: string;
}): { slug: string; title: string } => ({
  slug: slugifyPath(input.slug ?? input.title),
  title: leafTitle(input.title),
});

const recordRevision = async (
  db: Db,
  page: WikiPage,
  author: WikiAuthor
): Promise<void> => {
  await db.insert(wikiRevisions).values({
    authorId: author.id,
    authorType: author.type,
    body: page.body,
    id: crypto.randomUUID(),
    pageId: page.id,
    title: page.title,
  });
};

/**
 * The first revision records the page as created, so the history is complete
 * from the start rather than beginning at the first edit.
 */
export const createPage = async (
  db: Db,
  workspaceId: string,
  input: CreatePageInput
): Promise<WikiPage> => {
  const { slug, title } = normalizeWrite(input);
  const [page] = await db
    .insert(wikiPages)
    .values({
      body: input.body,
      id: crypto.randomUUID(),
      slug,
      title,
      workspaceId,
    })
    .returning();
  if (!page) {
    throw new Error("Failed to create the page.");
  }
  await recordRevision(db, page, input.author);
  return page;
};

export interface UpdatePageInput {
  author: WikiAuthor;
  body?: string;
  title?: string;
}

/**
 * The slug is not derived again on rename: it is the page's address, and
 * wiki-links and heading deep links already point at it. A path title is still
 * reduced to its leaf, so a rename cannot store "Ops/Runbooks" as the name.
 */
export const updatePage = async (
  db: Db,
  workspaceId: string,
  slug: string,
  input: UpdatePageInput
): Promise<WikiPage | undefined> => {
  const [page] = await db
    .update(wikiPages)
    .set({
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.title === undefined ? {} : { title: leafTitle(input.title) }),
      updatedAt: new Date(),
    })
    .where(
      and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.slug, slug))
    )
    .returning();
  if (!page) {
    return;
  }
  await recordRevision(db, page, input.author);
  return page;
};

/**
 * Create-or-update by address, for callers that do not know whether the page
 * exists yet (the agents' `wiki_write` tool). The slug defaults to one derived
 * from the title, so writing the same title twice edits one page.
 */
export const writePage = async (
  db: Db,
  workspaceId: string,
  input: CreatePageInput
): Promise<{ created: boolean; page: WikiPage }> => {
  const { slug } = normalizeWrite(input);
  const existing = await getPageBySlug(db, workspaceId, slug);
  if (!existing) {
    return {
      created: true,
      page: await createPage(db, workspaceId, { ...input, slug }),
    };
  }

  const page = await updatePage(db, workspaceId, slug, {
    author: input.author,
    body: input.body,
    title: input.title,
  });
  if (!page) {
    throw new Error("Failed to update the page.");
  }
  return { created: false, page };
};

export const deletePage = async (
  db: Db,
  workspaceId: string,
  slug: string
): Promise<boolean> => {
  const deleted = await db
    .delete(wikiPages)
    .where(
      and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.slug, slug))
    )
    .returning({ id: wikiPages.id });
  return deleted.length > 0;
};

/**
 * Every page of one workspace, for the workspace-delete cleanup. Revisions and
 * assets follow by `ON DELETE CASCADE`.
 */
export const deletePagesForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  await db.delete(wikiPages).where(eq(wikiPages.workspaceId, workspaceId));
};

export const listRevisions = (
  db: Db,
  pageId: string
): Promise<WikiRevision[]> =>
  db
    .select()
    .from(wikiRevisions)
    .where(eq(wikiRevisions.pageId, pageId))
    .orderBy(desc(wikiRevisions.createdAt));

/** Scoped to the page so a revision id from another page cannot be read here. */
export const getRevision = async (
  db: Db,
  pageId: string,
  revisionId: string
): Promise<WikiRevision | undefined> => {
  const [revision] = await db
    .select()
    .from(wikiRevisions)
    .where(
      and(eq(wikiRevisions.pageId, pageId), eq(wikiRevisions.id, revisionId))
    );
  return revision;
};

// --- assets -----------------------------------------------------------------

export type StoreAssetResult =
  | { ok: true; asset: WikiAsset }
  | { ok: false; reason: string };

/**
 * Uploads happen while the page is still being written, so `pageId` is optional
 * and the asset simply stays unattached until a page claims it. A page that is
 * named has to be one of this workspace's.
 */
export const storeAsset = async (
  db: Db,
  workspaceId: string,
  bucket: R2Bucket,
  file: File,
  pageId?: string
): Promise<StoreAssetResult> => {
  const validation = validateWikiAsset({
    filename: file.name,
    mime: file.type,
    size: file.size,
  });
  if (!validation.ok) {
    return validation;
  }

  if (pageId && !(await pageIsInWorkspace(db, workspaceId, pageId))) {
    return { ok: false, reason: "Page not found." };
  }

  const id = crypto.randomUUID();
  const r2Key = `${ASSET_KEY_PREFIX}${id}`;
  await bucket.put(r2Key, file.stream(), {
    httpMetadata: { contentType: validation.mime },
  });

  const [asset] = await db
    .insert(wikiAssets)
    .values({
      filename: validation.filename,
      id,
      mime: validation.mime,
      pageId: pageId ?? null,
      r2Key,
      size: file.size,
    })
    .returning();

  if (!asset) {
    await bucket.delete(r2Key);
    throw new Error("Failed to record the asset.");
  }
  return { asset, ok: true };
};

const pageIsInWorkspace = async (
  db: Db,
  workspaceId: string,
  pageId: string
): Promise<boolean> => {
  const [page] = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(
      and(eq(wikiPages.workspaceId, workspaceId), eq(wikiPages.id, pageId))
    );
  return page !== undefined;
};

/**
 * An asset reached by bare id, scoped through its page - `wiki_assets` carries
 * no workspace column of its own.
 *
 * An asset with no page yet is a just-uploaded file the editor is about to
 * reference: no parent to scope it through, an unguessable UUID for an id, and
 * refusing it would break the preview of what was uploaded a moment ago.
 */
export const getAssetInWorkspace = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<WikiAsset | undefined> => {
  const [asset] = await db
    .select()
    .from(wikiAssets)
    .where(eq(wikiAssets.id, id));
  if (!asset) {
    return;
  }
  if (!asset.pageId) {
    return asset;
  }
  return (await pageIsInWorkspace(db, workspaceId, asset.pageId))
    ? asset
    : undefined;
};
