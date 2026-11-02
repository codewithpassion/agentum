import { useRouterState } from "@tanstack/react-router";
import { Kanban, Search } from "lucide-react";
import { Button, buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { RailLink } from "./rail-link.tsx";
import { ACTION_BUTTON_CLASS, RailNewMenu } from "./rail-new-menu.tsx";

/** True on `/desk?view=board`, the page the Board link points at. */
export function isBoardView(location: {
  pathname: string;
  search: unknown;
}): boolean {
  const { view } = location.search as { view?: unknown };
  return location.pathname === "/desk" && view === "board";
}

/** Board, Find and New, the three controls in the top bar. */
export function RailHeaderActions({
  agents,
  onNavigate,
  onOpenFind,
}: {
  agents: readonly { id: string; name: string }[];
  onNavigate: () => void;
  onOpenFind: () => void;
}) {
  const onBoard = useRouterState({
    select: (state) => isBoardView(state.location),
  });
  return (
    <>
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
      </Button>
      <RailNewMenu agents={agents} onNavigate={onNavigate} />
    </>
  );
}
