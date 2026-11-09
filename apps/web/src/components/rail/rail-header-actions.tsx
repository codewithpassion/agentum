import { useRouterState } from "@tanstack/react-router";
import { Kanban, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAssistantLocation } from "#/components/assistant/assistant-location";
import { Button, buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { RailLink } from "./rail-link.tsx";
import { ACTION_BUTTON_CLASS, RailNewMenu } from "./rail-new-menu.tsx";

export const findShortcut = (platform: string) =>
  platform.includes("Mac") ? "⌘K" : "Ctrl K";

/** True on `/desk?view=board`, the page the Board link points at. */
export function isBoardView(location: {
  pathname: string;
  search: unknown;
}): boolean {
  const { view } = location.search as { view?: unknown };
  return location.pathname === "/desk" && view === "board";
}

/** Workspace controls in the top bar. */
export function RailHeaderActions({
  agents,
  onNavigate,
  onOpenFind,
}: {
  agents: readonly { id: string; name: string }[];
  onNavigate: () => void;
  onOpenFind: () => void;
}) {
  const { conversationId, open } = useAssistantLocation();
  const toggleAssistant = useCallback(
    () => open(conversationId ? null : "new"),
    [conversationId, open]
  );
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => setShortcut(findShortcut(navigator.platform)), []);
  const onBoard = useRouterState({
    select: (state) => isBoardView(state.location),
  });
  return (
    <>
      <Button
        aria-label="Assistant"
        aria-pressed={conversationId !== null}
        className={ACTION_BUTTON_CLASS}
        onClick={toggleAssistant}
        type="button"
        variant="outline"
      >
        <Sparkles />
        <span className="max-md:hidden">Assistant</span>
      </Button>
      <RailLink
        className={cn(
          buttonVariants({ variant: "outline" }),
          ACTION_BUTTON_CLASS,
          "no-underline"
        )}
        current={onBoard}
        href="/desk?view=board"
        label="Board"
        onNavigate={onNavigate}
      >
        <Kanban />
        <span className="max-md:hidden">Board</span>
      </RailLink>
      <Button
        aria-label="Find"
        className={ACTION_BUTTON_CLASS}
        onClick={onOpenFind}
        type="button"
        variant="outline"
      >
        <Search />
        <span className="max-md:hidden">Find</span>
        <kbd className="rounded border border-border px-1 text-[11px] text-muted-foreground max-md:hidden">
          {shortcut}
        </kbd>
      </Button>
      <RailNewMenu agents={agents} onNavigate={onNavigate} />
    </>
  );
}
