import type { RailItem, RailSetupStep } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { cn } from "#/lib/utils";
import { setupItemId } from "./pane-logic.ts";
import { SETUP_CONTENT } from "./setup-pane.tsx";

const ROW_CLASS =
  "block min-h-12 rounded-lg border border-border border-l-[3px] bg-card px-3 py-2.5 text-sm no-underline";

/** The Needs you list a phone shows on `/desk` with no item, where the rail is closed. */
export function InlineList({
  items,
  setup,
}: {
  items: readonly RailItem[];
  setup: readonly RailSetupStep[];
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="inline-list">
      <h1 className="font-heading text-3xl text-foreground">Needs you</h1>
      {setup.map((step) => (
        <Link
          className={cn(ROW_CLASS, "border-l-primary")}
          key={step}
          search={{ item: setupItemId(step) }}
          to="/desk"
        >
          <span className="font-semibold">{SETUP_CONTENT[step].title}</span>
        </Link>
      ))}
      {items.map((item) => {
        const [first] = item.cards;
        return (
          <Link
            className={cn(
              ROW_CLASS,
              first?.kind === "problem" && "border-l-destructive"
            )}
            key={item.id}
            search={{ item: item.id }}
            to="/desk"
          >
            <span className="block font-semibold">{first?.title}</span>
            <span className="block text-muted-foreground">
              {first?.agentName}
              {item.cards.length > 1 ? `, +${item.cards.length - 1} more` : ""}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
