import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalString,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { isInlineWikiAsset, MAX_WIKI_ASSET_BYTES } from "./asset-rules";
import type { WikiAuthor } from "./schema";
import {
  createPage,
  deletePage,
  getAssetInWorkspace,
  getPageBySlug,
  getRevision,
  listPages,
  listRevisions,
  storeAsset,
  toPageView,
  toRevisionViews,
  updatePage,
} from "./service";

const TITLE_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 200_000;
const PAYLOAD_TOO_LARGE = 413;

/** The slug is the only unique column on `wiki_pages`. */
const isDuplicateSlug = isUniqueConstraintError;

export const wikiRoutes = new Hono<ApiEnv>();

wikiRoutes.use("*", requireAuth);

/** Every write from this router is the signed-in human. */
const authorOf = (userId: string): WikiAuthor => ({ id: userId, type: "user" });

const assetView = (
  workspaceSlug: string,
  asset: { filename: string; id: string; mime: string; size: number }
) => ({
  filename: asset.filename,
  id: asset.id,
  mime: asset.mime,
  size: asset.size,
  url: `/api/w/${workspaceSlug}/wiki/assets/${asset.id}`,
});

// --- assets -----------------------------------------------------------------
// Registered before `/:slug`, which would otherwise swallow `/assets`.

wikiRoutes.post("/assets", async (c) => {
  // Cheap rejection before buffering the body; `storeAsset` re-checks the real
  // size, since Content-Length is client-supplied.
  const declaredLength = Number(c.req.header("content-length") ?? 0);
  if (declaredLength > MAX_WIKI_ASSET_BYTES) {
    return c.json({ error: "The file is too large." }, PAYLOAD_TOO_LARGE);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw badRequest('Expected a multipart "file" field.');
  }
  const pageId = form.get("pageId");

  const result = await storeAsset(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.env.ATTACHMENTS,
    file,
    typeof pageId === "string" && pageId.length > 0 ? pageId : undefined
  );
  if (!result.ok) {
    return c.json({ error: result.reason }, 400);
  }
  return c.json(
    { asset: assetView(c.get("workspace").slug, result.asset) },
    201
  );
});

wikiRoutes.get("/assets/:id", async (c) => {
  const asset = await getAssetInWorkspace(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("id")
  );
  if (!asset) {
    throw notFound("Asset not found.");
  }

  const object = await c.env.ATTACHMENTS.get(asset.r2Key);
  if (!object) {
    throw notFound("Asset content is missing.");
  }

  const disposition = isInlineWikiAsset(asset.mime) ? "inline" : "attachment";
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `${disposition}; filename="${asset.filename}"`,
      "Content-Length": String(asset.size),
      "Content-Type": asset.mime,
    },
  });
});

// --- pages ------------------------------------------------------------------

wikiRoutes.get("/", async (c) => {
  const pages = await listPages(createDb(c.env.DB), c.get("workspace").id);
  return c.json({ pages });
});

wikiRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const input = {
    author: authorOf(c.get("userId")),
    body: optionalString(body, "body", { maxLength: BODY_MAX_LENGTH }) ?? "",
    title: requireString(body, "title", { maxLength: TITLE_MAX_LENGTH }),
  };

  try {
    const page = await createPage(
      createDb(c.env.DB),
      c.get("workspace").id,
      input
    );
    return c.json({ page: toPageView(page) }, 201);
  } catch (error) {
    if (isDuplicateSlug(error)) {
      return c.json(
        { error: `A page called "${input.title}" already exists.` },
        409
      );
    }
    throw error;
  }
});

wikiRoutes.get("/:slug", async (c) => {
  const page = await getPageBySlug(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("slug")
  );
  if (!page) {
    throw notFound("Page not found.");
  }
  return c.json({ page: toPageView(page) });
});

wikiRoutes.patch("/:slug", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const page = await updatePage(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("slug"),
    {
      author: authorOf(c.get("userId")),
      body: optionalString(body, "body", { maxLength: BODY_MAX_LENGTH }),
      title: optionalString(body, "title", { maxLength: TITLE_MAX_LENGTH }),
    }
  );
  if (!page) {
    throw notFound("Page not found.");
  }
  return c.json({ page: toPageView(page) });
});

wikiRoutes.delete("/:slug", async (c) => {
  const deleted = await deletePage(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("slug")
  );
  if (!deleted) {
    throw notFound("Page not found.");
  }
  return c.body(null, 204);
});

// --- revisions --------------------------------------------------------------

wikiRoutes.get("/:slug/revisions", async (c) => {
  const db = createDb(c.env.DB);
  const page = await getPageBySlug(
    db,
    c.get("workspace").id,
    c.req.param("slug")
  );
  if (!page) {
    throw notFound("Page not found.");
  }
  const revisions = await listRevisions(db, page.id);
  return c.json({
    revisions: await toRevisionViews(db, c.get("workspace").id, revisions),
  });
});

wikiRoutes.get("/:slug/revisions/:revisionId", async (c) => {
  const db = createDb(c.env.DB);
  const page = await getPageBySlug(
    db,
    c.get("workspace").id,
    c.req.param("slug")
  );
  if (!page) {
    throw notFound("Page not found.");
  }
  const revision = await getRevision(db, page.id, c.req.param("revisionId"));
  if (!revision) {
    throw notFound("Revision not found.");
  }
  const [view] = await toRevisionViews(db, c.get("workspace").id, [revision]);
  return c.json({ revision: view });
});
