import type { ActionLogEntry } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { logTagClass } from "./task-logic.ts";

function LogRow({ entry }: { entry: ActionLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  return (
    <li
      className="grid grid-cols-[52px_1fr] gap-2 border-b py-2 text-sm md:grid-cols-[52px_92px_1fr]"
      data-kind={entry.kind}
      data-testid="action-log-entry"
    >
      <time className="text-muted-foreground text-xs" dateTime={entry.at}>
        {entry.at.slice(11, 16)}
      </time>
      <span
        className={`self-start justify-self-start rounded px-1.5 py-px font-mono text-[11px] ${logTagClass(entry.kind)}`}
      >
        {entry.kind}
      </span>
      <div className="col-start-2 min-w-0 md:col-start-3">
        <p
          className={`${expanded ? "" : "line-clamp-4"} whitespace-pre-wrap break-words`}
        >
          {entry.text}
        </p>
        {!expanded &&
        (entry.text.length > 240 || entry.text.split("\n").length > 4) ? (
          <Button
            className="h-10 md:h-9"
            onClick={expand}
            size="sm"
            variant="ghost"
          >
            Show all
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** The viewed run's events, oldest first; the tab owns scrolling. */
export function ActionLog({ entries }: { entries: ActionLogEntry[] }) {
  return entries.length === 0 ? (
    <p className="text-muted-foreground text-sm">Nothing logged yet.</p>
  ) : (
    <ul className="w-full">
      {entries.map((entry) => (
        <LogRow entry={entry} key={entry.eventId} />
      ))}
    </ul>
  );
}
