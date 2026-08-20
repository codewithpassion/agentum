import { and, asc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { type CATEGORY_ITEM_TYPES, categories, categoryItems } from "./schema";

export type CategoryItemType = (typeof CATEGORY_ITEM_TYPES)[number];

export interface CategoryItemRef {
  itemId: string;
  itemType: CategoryItemType;
}

export interface CategoryView {
  id: string;
  items: CategoryItemRef[];
  name: string;
}

const listItems = (db: Db, categoryId: string): Promise<CategoryItemRef[]> =>
  db
    .select({
      itemId: categoryItems.itemId,
      itemType: categoryItems.itemType,
    })
    .from(categoryItems)
    .where(eq(categoryItems.categoryId, categoryId));

export const listCategories = async (db: Db): Promise<CategoryView[]> => {
  const [rows, items] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.createdAt)),
    db.select().from(categoryItems),
  ]);

  const itemsByCategory = new Map<string, CategoryItemRef[]>();
  for (const item of items) {
    const list = itemsByCategory.get(item.categoryId) ?? [];
    list.push({ itemId: item.itemId, itemType: item.itemType });
    itemsByCategory.set(item.categoryId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    items: itemsByCategory.get(row.id) ?? [],
    name: row.name,
  }));
};

export const getCategory = async (
  db: Db,
  id: string
): Promise<CategoryView | undefined> => {
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  if (!row) {
    return;
  }
  return { id: row.id, items: await listItems(db, id), name: row.name };
};

export const createCategory = async (
  db: Db,
  input: { name: string }
): Promise<CategoryView> => {
  const [row] = await db
    .insert(categories)
    .values({ id: crypto.randomUUID(), name: input.name })
    .returning();
  if (!row) {
    throw new Error("Failed to create the category.");
  }
  return { id: row.id, items: [], name: row.name };
};

export const renameCategory = async (
  db: Db,
  id: string,
  name: string
): Promise<CategoryView | undefined> => {
  const [row] = await db
    .update(categories)
    .set({ name })
    .where(eq(categories.id, id))
    .returning();
  if (!row) {
    return;
  }
  return { id: row.id, items: await listItems(db, id), name: row.name };
};

/** The cascade on `category_items` leaves the category's items uncategorized. */
export const deleteCategory = async (db: Db, id: string): Promise<boolean> => {
  const deleted = await db
    .delete(categories)
    .where(eq(categories.id, id))
    .returning({ id: categories.id });
  return deleted.length > 0;
};

/** An item lives in at most one category, so assigning moves it. */
export const assignItem = async (
  db: Db,
  categoryId: string,
  item: CategoryItemRef
): Promise<void> => {
  await db
    .insert(categoryItems)
    .values({ categoryId, ...item })
    .onConflictDoUpdate({
      set: { categoryId },
      target: [categoryItems.itemType, categoryItems.itemId],
    });
};

export const unassignItem = async (
  db: Db,
  item: CategoryItemRef
): Promise<void> => {
  await db
    .delete(categoryItems)
    .where(
      and(
        eq(categoryItems.itemType, item.itemType),
        eq(categoryItems.itemId, item.itemId)
      )
    );
};
