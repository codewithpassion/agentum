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
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
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

/** Items are resolved through the owning module's public service, never its tables. */
const assertItemIsCategorizable = async (
  db: Db,
  item: CategoryItemRef
): Promise<void> => {
  if (item.itemType === "agent") {
    if (!(await getAgentById(db, item.itemId))) {
      throw notFound("Agent not found.");
    }
    return;
  }

  const channel = await getChannel(db, item.itemId);
  if (!channel) {
    throw notFound("Channel not found.");
  }
  if (channel.kind !== "channel") {
    throw badRequest("Direct messages cannot be categorized.");
  }
};

categoriesRoutes.get("/", async (c) => {
  const categories = await listCategories(createDb(c.env.DB));
  return c.json({ categories });
});

categoriesRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = requireString(body, "name", {
    maxLength: CATEGORY_NAME_MAX_LENGTH,
  });
  // TODO(phase-2): replace with requireWorkspace context.
  const category = await createCategory(
    createDb(c.env.DB),
    DEFAULT_WORKSPACE_ID,
    {
      name,
    }
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
    c.req.param("id"),
    name
  );
  if (!category) {
    throw notFound("Category not found.");
  }
  return c.json({ category });
});

categoriesRoutes.delete("/:id", async (c) => {
  const deleted = await deleteCategory(createDb(c.env.DB), c.req.param("id"));
  if (!deleted) {
    throw notFound("Category not found.");
  }
  return c.body(null, 204);
});

categoriesRoutes.put("/:id/items", async (c) => {
  const db = createDb(c.env.DB);
  const categoryId = c.req.param("id");
  if (!(await getCategory(db, categoryId))) {
    throw notFound("Category not found.");
  }

  const body = await readJsonObject(c.req.raw);
  const item: CategoryItemRef = {
    itemId: requireString(body, "itemId"),
    itemType: requireEnum(body, "itemType", CATEGORY_ITEM_TYPES),
  };
  await assertItemIsCategorizable(db, item);

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

  await unassignItem(createDb(c.env.DB), {
    itemId: c.req.param("itemId"),
    itemType,
  });
  return c.body(null, 204);
});
