import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  readJsonObject,
  requireEnum,
  requireString,
} from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { getChannel } from "#/modules/messaging/service";
import { CATEGORY_ITEM_TYPES } from "./schema";
import {
  assignItem,
  type CategoryItemRef,
  type CategoryItemType,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  renameCategory,
  unassignItem,
} from "./service";

const CATEGORY_NAME_MAX_LENGTH = 80;

export const categoriesRoutes = new Hono<ApiEnv>();

categoriesRoutes.use("*", requireAuth);

const isCategoryItemType = (value: string): value is CategoryItemType =>
  (CATEGORY_ITEM_TYPES as readonly string[]).includes(value);

/**
 * Items are resolved through the owning module's public service, never its
 * tables - and within this workspace, so a category here can never be made to
 * point at another tenant's agent or channel.
 */
const assertItemIsCategorizable = async (
  db: Db,
  workspaceId: string,
  item: CategoryItemRef
): Promise<void> => {
  if (item.itemType === "agent") {
    if (!(await getAgentById(db, workspaceId, item.itemId))) {
      throw notFound("Agent not found.");
    }
    return;
  }

  const channel = await getChannel(db, workspaceId, item.itemId);
  if (!channel) {
    throw notFound("Channel not found.");
  }
  if (channel.kind !== "channel") {
    throw badRequest("Direct messages cannot be categorized.");
  }
};

categoriesRoutes.get("/", async (c) => {
  const categories = await listCategories(
    createDb(c.env.DB),
    c.get("workspace").id
  );
  return c.json({ categories });
});

categoriesRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = requireString(body, "name", {
    maxLength: CATEGORY_NAME_MAX_LENGTH,
  });
  const category = await createCategory(
    createDb(c.env.DB),
    c.get("workspace").id,
    { name }
  );
  return c.json({ category }, 201);
});

categoriesRoutes.patch("/:id", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = requireString(body, "name", {
    maxLength: CATEGORY_NAME_MAX_LENGTH,
  });
  const category = await renameCategory(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("id"),
    name
  );
  if (!category) {
    throw notFound("Category not found.");
  }
  return c.json({ category });
});

categoriesRoutes.delete("/:id", async (c) => {
  const deleted = await deleteCategory(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("id")
  );
  if (!deleted) {
    throw notFound("Category not found.");
  }
  return c.body(null, 204);
});

categoriesRoutes.put("/:id/items", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const categoryId = c.req.param("id");
  if (!(await getCategory(db, workspaceId, categoryId))) {
    throw notFound("Category not found.");
  }

  const body = await readJsonObject(c.req.raw);
  const item: CategoryItemRef = {
    itemId: requireString(body, "itemId"),
    itemType: requireEnum(body, "itemType", CATEGORY_ITEM_TYPES),
  };
  await assertItemIsCategorizable(db, workspaceId, item);

  await assignItem(db, categoryId, item);
  return c.body(null, 204);
});

categoriesRoutes.delete("/:id/items/:itemType/:itemId", async (c) => {
  const itemType = c.req.param("itemType");
  if (!isCategoryItemType(itemType)) {
    throw badRequest(
      `"itemType" must be one of: ${CATEGORY_ITEM_TYPES.join(", ")}.`
    );
  }

  // `category_items` carries no workspace of its own, so the category named in
  // the path is resolved first and the unassign runs underneath it.
  const db = createDb(c.env.DB);
  const categoryId = c.req.param("id");
  if (!(await getCategory(db, c.get("workspace").id, categoryId))) {
    throw notFound("Category not found.");
  }

  await unassignItem(db, categoryId, {
    itemId: c.req.param("itemId"),
    itemType,
  });
  return c.body(null, 204);
});
