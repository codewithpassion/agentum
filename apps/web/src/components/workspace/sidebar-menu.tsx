import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import {
  assignCategoryItem,
  type CategoryItemRef,
  type CategoryView,
  unassignCategoryItem,
} from "#/lib/api";
import { cx } from "#/lib/cx";

export const MENU_ITEM_CLASS =
  "ws-focus block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--ws-surface-hover)]";

function MoveOption({
  category,
  onSelect,
}: {
  category: CategoryView;
  onSelect: (categoryId: string) => void;
}) {
  const select = useCallback(
    () => onSelect(category.id),
    [category.id, onSelect]
  );
  return (
    <button className={MENU_ITEM_CLASS} onClick={select} type="button">
      Move to {category.name}
    </button>
  );
}

/**
 * Per-row category menu. Hidden until the row is hovered or focused, and kept
 * visible while its own popover is open so the pointer can reach the panel.
 */
export function ItemCategoryMenu({
  categories,
  categoryId,
  itemId,
  itemName,
  itemType,
  onChanged,
}: {
  categories: CategoryView[];
  categoryId: string | null;
  itemId: string;
  itemName: string;
  itemType: CategoryItemRef["itemType"];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((previous) => !previous), []);
  const close = useCallback(() => setOpen(false), []);

  const move = useCallback(
    (targetId: string) => {
      (async () => {
        // An item lives in at most one category, so assigning moves it.
        await assignCategoryItem(targetId, { itemId, itemType });
        setOpen(false);
        await onChanged();
      })();
    },
    [itemId, itemType, onChanged]
  );

  const remove = useCallback(() => {
    if (!categoryId) {
      return;
    }
    (async () => {
      await unassignCategoryItem(categoryId, { itemId, itemType });
      setOpen(false);
      await onChanged();
    })();
  }, [categoryId, itemId, itemType, onChanged]);

  const targets = categories.filter((category) => category.id !== categoryId);
  if (targets.length === 0 && !categoryId) {
    return null;
  }

  return (
    <div
      className={cx(
        "relative transition-opacity",
        open
          ? "opacity-100"
          : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
      )}
    >
      <Button
        aria-label={`Categorise ${itemName}`}
        onClick={toggle}
        size="icon"
        title={`Categorise ${itemName}`}
        variant="ghost"
      >
        <span aria-hidden="true">⋯</span>
      </Button>
      <Popover align="right" onClose={close} open={open}>
        {targets.map((category) => (
          <MoveOption category={category} key={category.id} onSelect={move} />
        ))}
        {categoryId ? (
          <button className={MENU_ITEM_CLASS} onClick={remove} type="button">
            Remove from category
          </button>
        ) : null}
      </Popover>
    </div>
  );
}
