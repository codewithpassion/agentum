import type { MemoryNote } from "@repo/db/shared";
import type { ReactElement } from "react";
import {
  formatNoteDate,
  groupNotes,
  KIND_LABELS,
} from "#/components/agent/room/knows/notes-logic.ts";

const EMPTY_TEXT =
  "The team has no shared notes yet. A team dream lifts what three members hold into team memory.";

export function TeamNotes({
  notes,
}: {
  notes: readonly MemoryNote[];
}): ReactElement {
  const groups = groupNotes(notes, []);
  if (groups.length === 0) {
    return <p className="text-muted-foreground text-sm">{EMPTY_TEXT}</p>;
  }
  return (
    <div className="space-y-4" data-testid="team-notes">
      {groups.map((group) => (
        <section className="space-y-2" key={group.kind}>
          <h3 className="font-medium text-sm">{KIND_LABELS[group.kind]}</h3>
          <ul className="space-y-3">
            {group.notes.map((note) => (
              <li key={note.id}>
                <p className="whitespace-pre-line text-sm [overflow-wrap:anywhere]">
                  {note.text}
                </p>
                <p className="text-muted-foreground text-xs">
                  {formatNoteDate(note.date)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
