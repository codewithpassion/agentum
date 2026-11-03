import { Link } from "@tanstack/react-router";
import type { MailCount } from "./mail-strip-logic.ts";
import { heldCountText, inCountText, mailRowsFor } from "./mail-strip-logic.ts";

/** Today's mail per agent address, with a link to each agent's Mail sheet. Empty renders nothing. */
export function MailStrip({
  agent,
  rows,
}: {
  agent: string | undefined;
  rows: readonly MailCount[];
}) {
  const shown = mailRowsFor(rows, agent);
  if (shown.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Agent mail today"
      className="flex flex-col gap-2 rounded-xl border bg-card p-3"
      data-testid="mail-strip"
    >
      <h2 className="font-semibold text-sm">Agent mail today</h2>
      <ul className="flex flex-col gap-1.5">
        {shown.map((row) => (
          <li key={row.address}>
            <Link
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
              data-testid="mail-strip-row"
              params={{ agentId: row.agentId }}
              search={{ mail: "1" }}
              to="/agents/$agentId"
            >
              <span className="min-w-0 truncate">{row.address}</span>
              <span className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
                <span>{inCountText(row.in)}</span>
                <span
                  className={
                    row.held > 0 ? "font-medium text-warning" : undefined
                  }
                >
                  {heldCountText(row.held)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
