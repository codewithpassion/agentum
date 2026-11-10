import { formatDistanceToNow } from "date-fns";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { RailLink } from "#/components/rail/rail-link.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  type ConversationListItem,
  KIND_LABELS,
  nestChildren,
} from "./conversation-logic.ts";

const INDENT_CLASSES: Record<number, string | undefined> = {
  1: "ml-4 border-border border-l pl-1",
  2: "ml-8 border-border border-l pl-1",
};

const ROW_CLASS =
  "flex w-full flex-col gap-0.5 rounded-md px-3 py-3 text-left text-sm no-underline hover:bg-muted";

function RowBody({
  item,
  showKind,
}: {
  item: ConversationListItem;
  showKind: boolean;
}) {
  return (
    <>
      <span className="truncate">{item.title}</span>
      {item.detail === undefined ? null : (
        <span className="truncate text-muted-foreground text-xs">
          {item.detail}
        </span>
      )}
      <span className="flex items-center gap-2 text-muted-foreground text-xs">
        {showKind ? (
          <span className="rounded-full border border-border px-1.5">
            {KIND_LABELS[item.kind]}
          </span>
        ) : null}
        {/* The relative time reads the clock, so the server and browser can differ by a bucket. */}
        <time dateTime={item.activityAt} suppressHydrationWarning>
          {formatDistanceToNow(new Date(item.activityAt), { addSuffix: true })}
        </time>
      </span>
    </>
  );
}

function Row({
  active,
  depth,
  disabled,
  item,
  onSelect,
  showKind,
}: {
  active: boolean;
  depth: number;
  disabled: boolean;
  item: ConversationListItem;
  onSelect: ((item: ConversationListItem) => void) | undefined;
  showKind: boolean;
}) {
  const select = useCallback(() => onSelect?.(item), [item, onSelect]);
  const className = `${ROW_CLASS} ${active ? "bg-muted font-medium" : "text-muted-foreground"}`;
  return (
    <li className={INDENT_CLASSES[depth]}>
      {item.href === undefined ? (
        <button
          aria-current={active ? "true" : undefined}
          className={className}
          data-conversation-id={item.id}
          disabled={disabled}
          onClick={select}
          type="button"
        >
          <RowBody item={item} showKind={showKind} />
        </button>
      ) : (
        <RailLink
          className={className}
          current={active}
          href={item.href}
          onNavigate={select}
        >
          <RowBody item={item} showKind={showKind} />
        </RailLink>
      )}
    </li>
  );
}

/**
 * Conversations, newest first, with a time on each row. Used in the assistant
 * panel and on the history page. A row with an `href` is a link, any other row
 * is a button, and both call `onSelect`. Paging is the caller's: it passes
 * `onLoadMore` while there is another page.
 */
export function ConversationList({
  actions,
  activeId,
  disabled = false,
  emptyText,
  heading,
  items,
  label,
  loadingMore = false,
  onLoadMore,
  onNew,
  onSelect,
  showKind = false,
}: {
  /** Extra header controls, shown before the New button. */
  actions?: ReactNode;
  activeId?: string | null;
  disabled?: boolean;
  emptyText: string;
  /** A header with this title, and the New button when `onNew` is set. */
  heading?: string;
  items: readonly ConversationListItem[];
  label: string;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onNew?: () => void;
  onSelect?: (item: ConversationListItem) => void;
  /** Marks each row with its kind. Worth it only where the list mixes kinds. */
  showKind?: boolean;
}) {
  return (
    <>
      {heading === undefined ? null : (
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-medium text-sm">{heading}</h2>
          <div className="flex items-center gap-1">
            {actions}
            {onNew === undefined ? null : (
              <Button
                aria-label="New conversation"
                disabled={disabled}
                onClick={onNew}
                size="icon"
                variant="ghost"
              >
                <Plus className="size-4" />
              </Button>
            )}
          </div>
        </div>
      )}
      <nav aria-label={label} className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-3 py-4 text-muted-foreground text-sm">{emptyText}</p>
        ) : (
          <ul className="space-y-1">
            {nestChildren(items).map(({ depth, item }) => (
              <Row
                active={activeId === item.id}
                depth={depth}
                disabled={disabled}
                item={item}
                key={`${item.kind}:${item.id}`}
                onSelect={onSelect}
                showKind={showKind}
              />
            ))}
          </ul>
        )}
        {onLoadMore === undefined ? null : (
          <Button
            className="mt-2 w-full"
            disabled={loadingMore}
            onClick={onLoadMore}
            size="sm"
            variant="ghost"
          >
            {loadingMore ? "Loading…" : "Show more"}
          </Button>
        )}
      </nav>
    </>
  );
}
