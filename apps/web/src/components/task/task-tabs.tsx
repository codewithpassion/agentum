import { useCallback, useState } from "react";

export type TaskTab = "conversation" | "files" | "log" | "mail" | "computer";

export function tabFocusIndex(
  key: string,
  index: number,
  count: number
): number | null {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function TaskTabs({
  files,
  log,
  mail,
  computer,
  pending,
  takeover = false,
  conflict,
  selected,
  onSelect,
}: {
  files: number;
  log: number;
  mail: number | null;
  computer: boolean;
  pending: boolean;
  takeover?: boolean;
  conflict: boolean;
  selected: TaskTab;
  onSelect: (tab: TaskTab) => void;
}) {
  const [focused, setFocused] = useState<TaskTab>(selected);
  const click = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) =>
      onSelect(event.currentTarget.dataset.tab as TaskTab),
    [onSelect]
  );
  const focus = useCallback(
    (event: React.FocusEvent<HTMLButtonElement>) =>
      setFocused(event.currentTarget.dataset.tab as TaskTab),
    []
  );
  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const buttons = Array.from(
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
          '[role="tab"]'
        ) ?? []
      ).filter(
        (button) =>
          button.dataset.desktopHidden !== "true" ||
          !window.matchMedia("(min-width: 768px)").matches
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
    },
    []
  );
  const tabs: { id: TaskTab; label: string; count?: number; dot?: boolean }[] =
    [
      { dot: pending, id: "conversation", label: "Conversation" },
      { count: files, dot: conflict, id: "files", label: "Files" },
      { count: log, id: "log", label: "Log" },
      ...(mail === null
        ? []
        : [{ count: mail, id: "mail" as const, label: "Mail" }]),
      ...(computer
        ? [{ dot: takeover, id: "computer" as const, label: "Computer" }]
        : []),
    ];
  return (
    <div
      aria-label="Task"
      className="flex shrink-0 border-b px-2 md:px-6"
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          aria-controls={`task-panel-${tab.id}`}
          aria-selected={selected === tab.id}
          className={`flex min-h-11 min-w-0 items-center justify-center gap-1 border-b-2 px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring md:px-3.5 md:text-sm ${tab.id === "computer" && selected !== "computer" ? "md:hidden" : ""} ${selected === tab.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
          data-desktop-hidden={tab.id === "computer" && selected !== "computer"}
          data-tab={tab.id}
          id={`task-tab-${tab.id}`}
          key={tab.id}
          onClick={click}
          onFocus={focus}
          onKeyDown={keyDown}
          role="tab"
          tabIndex={focused === tab.id ? 0 : -1}
          type="button"
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="text-muted-foreground text-xs">{tab.count}</span>
          )}
          {tab.dot ? (
            <span
              aria-label="Needs attention"
              className="size-1.5 shrink-0 rounded-full bg-warning"
              role="img"
            />
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function RequestBanner({
  kind,
  selected,
  onReview,
}: {
  kind: "approval" | "question" | "takeover" | null;
  selected: TaskTab;
  onReview: () => void;
}) {
  if (
    kind === null ||
    selected === "conversation" ||
    (selected === "computer" && kind === "takeover")
  ) {
    return null;
  }
  const action = {
    approval: "Review approval",
    question: "Answer question",
    takeover: "Take over",
  }[kind];
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-warning/40 border-b bg-warning/10 px-4 text-sm text-warning md:px-6">
      <span className="truncate">The agent needs you.</span>
      <button
        className="h-10 shrink-0 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onReview}
        type="button"
      >
        {action}
      </button>
    </div>
  );
}
