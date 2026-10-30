import type { RailCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { howItGotHere } from "./pane-logic.ts";

const formatAt = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(Date.parse(iso));

/** A collapsed account of who started the work, and a way to its full log. */
export function HowItGotHere({ card }: { card: RailCard }) {
  return (
    <details
      className="mt-4 text-muted-foreground text-sm"
      data-testid="how-it-got-here"
    >
      <summary className="pointer-coarse:min-h-10 cursor-pointer">
        How it got here
      </summary>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        {howItGotHere(card, formatAt).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {card.runId === null ? null : (
        <p className="mt-2">
          <Link
            className="underline underline-offset-2"
            params={{ runId: card.runId }}
            to="/tasks/$runId"
          >
            Open the full log
          </Link>
        </p>
      )}
    </details>
  );
}
