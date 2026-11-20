import type { MemoryChangeAction, MemoryChangeStatus } from "@repo/db/shared";
import type { ReactElement } from "react";
import type { DreamChangeView } from "./dream-changes.ts";

const ACTION_LEADS: Record<MemoryChangeAction, string> = {
  add: "Added a note",
  edit: "Changed a note",
  forget: "Dropped a note",
  merge: "Merged notes",
};

const STATUS_NOTES: Record<MemoryChangeStatus, string | null> = {
  applied: null,
  held: "Held for your approval.",
  rejected: null,
  undone: "Undone.",
};

function leadOf(view: DreamChangeView): string {
  const { change } = view;
  if (change.action === "forget" && change.groupId !== null) {
    return "Folded into a merged note";
  }
  return ACTION_LEADS[change.action];
}

function ChangeRow({ view }: { view: DreamChangeView }): ReactElement {
  const { after, before, change } = view;
  const statusNote = STATUS_NOTES[change.status];
  return (
    <li className="flex flex-col gap-1 py-2" data-testid="dream-change">
      <p className="font-medium text-sm">{leadOf(view)}</p>
      {statusNote === null ? null : (
        <p className="text-muted-foreground text-xs">{statusNote}</p>
      )}
      {before === null ? null : (
        <div className="flex flex-col">
          <p className="text-muted-foreground text-xs">Before</p>
          <p className="break-words text-muted-foreground">{before}</p>
        </div>
      )}
      {after === null ? null : (
        <div className="flex flex-col">
          <p className="text-xs">After</p>
          <p className="break-words">{after}</p>
        </div>
      )}
    </li>
  );
}

export function ChangesList({
  changes,
}: {
  changes: readonly DreamChangeView[];
}): ReactElement {
  if (changes.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        This dream changed no notes.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {changes.map((view) => (
        <ChangeRow key={view.change.id} view={view} />
      ))}
    </ul>
  );
}
