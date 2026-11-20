import { type KeyboardEvent, type MouseEvent, useCallback } from "react";
import { tabFocusIndex } from "#/components/task/task-tabs.tsx";
import { ROOM_TABS, type RoomTab, TAB_LABELS } from "./tabs.ts";

export const tabId = (tab: RoomTab): string => `room-tab-${tab}`;
export const panelId = (tab: RoomTab): string => `room-panel-${tab}`;

/** The seven room tabs. Arrow keys move focus, Enter or Space selects. */
export function TabBar({
  onSelect,
  selected,
}: {
  onSelect: (tab: RoomTab) => void;
  selected: RoomTab;
}) {
  const click = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      onSelect(event.currentTarget.dataset.tab as RoomTab),
    [onSelect]
  );
  const keyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]'
      ) ?? []
    );
    const next = tabFocusIndex(
      event.key,
      buttons.indexOf(event.currentTarget),
      buttons.length
    );
    if (next !== null) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  }, []);
  return (
    <div
      aria-label="Agent room"
      className="-mx-4 flex gap-1 overflow-x-auto border-border border-b px-4 md:mx-0 md:px-0"
      role="tablist"
    >
      {ROOM_TABS.map((tab) => (
        <button
          aria-controls={panelId(tab)}
          aria-selected={tab === selected}
          className={`-mb-px pointer-coarse:min-h-11 shrink-0 border-b-2 px-3 py-2 font-medium text-sm ${
            tab === selected
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-tab={tab}
          id={tabId(tab)}
          key={tab}
          onClick={click}
          onKeyDown={keyDown}
          role="tab"
          tabIndex={tab === selected ? 0 : -1}
          type="button"
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}
