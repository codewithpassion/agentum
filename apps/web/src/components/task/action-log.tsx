import type { ActionLogEntry } from "@repo/db/shared";
import { logTagClass } from "./task-logic.ts";

/** The task's action log, oldest first, in a scrolling card. */
export function ActionLog({ entries }: { entries: ActionLogEntry[] }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-card-foreground">
      <h2 className="mb-1.5 font-semibold text-[15px]">Action log</h2>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing logged yet.</p>
      ) : (
        <ul className="max-h-96 overflow-y-auto">
          {entries.map((entry, index) => (
            <li
              className={`grid grid-cols-[92px_1fr] gap-2.5 py-1.5 text-sm ${index > 0 ? "border-t" : ""}`}
              data-kind={entry.kind}
              data-testid="action-log-entry"
              key={entry.eventId}
            >
              <span
                className={`justify-self-start rounded px-1.5 py-px font-mono text-[11px] ${logTagClass(entry.kind)}`}
              >
                {entry.kind}
              </span>
              <span
                className="line-clamp-4 whitespace-pre-wrap break-words"
                title={entry.at}
              >
                {entry.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
