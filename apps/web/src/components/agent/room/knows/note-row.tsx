import {
  MEMORY_NOTE_MAX_CHARS,
  type MemoryChange,
  type MemoryNote,
  type MemorySource,
  type MemoryWriter,
} from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useState } from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import {
  formatNoteDate,
  heldLead,
  noteLead,
  SOURCE_LABELS,
} from "./notes-logic.ts";

const WRITER_LABELS: Record<MemoryWriter, string> = {
  agent: "The agent",
  dream: "A dream",
  person: "You",
};

function SourceLink({ source }: { source: MemorySource }): ReactElement {
  const label = SOURCE_LABELS[source.kind];
  if (source.kind === "session") {
    return (
      <Link params={{ sessionId: source.id }} to="/threads/$sessionId">
        {label}
      </Link>
    );
  }
  if (source.kind === "run") {
    return (
      <Link params={{ runId: source.id }} to="/tasks/$runId">
        {label}
      </Link>
    );
  }
  return <Link to="/desk">{label}</Link>;
}

export function NoteRow({
  busy,
  disabled,
  note,
  onEdit,
  onForget,
}: {
  busy: boolean;
  disabled: boolean;
  note: MemoryNote;
  onEdit: (noteId: string, text: string) => void;
  onForget: (noteId: string) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const locked = disabled || busy;
  const trimmed = draft.trim();
  const saveDisabled =
    locked ||
    trimmed === "" ||
    trimmed === note.text ||
    trimmed.length > MEMORY_NOTE_MAX_CHARS;

  const startEdit = useCallback(() => {
    setDraft(note.text);
    setEditing(true);
  }, [note.text]);
  const changeDraft = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
  }, []);
  const cancelEdit = useCallback(() => setEditing(false), []);
  const save = useCallback(() => {
    onEdit(note.id, trimmed);
    setEditing(false);
  }, [note.id, onEdit, trimmed]);
  const forget = useCallback(() => onForget(note.id), [note.id, onForget]);

  return (
    <div className="flex flex-col gap-1 py-2" data-testid="note-row">
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Edit note"
            disabled={locked}
            onChange={changeDraft}
            value={draft}
          />
          <div className="flex gap-2">
            <Button
              disabled={saveDisabled}
              onClick={save}
              size="sm"
              type="button"
            >
              Save
            </Button>
            <Button
              onClick={cancelEdit}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p>{note.text}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <p>
          {noteLead(note)}
          {note.source === null ? null : (
            <>
              {" "}
              <SourceLink source={note.source} />
            </>
          )}
          {`, ${formatNoteDate(note.date)}`}
        </p>
        {note.userScope === null ? null : (
          <Badge data-testid="private-marker" variant="secondary">
            Private
          </Badge>
        )}
      </div>
      {editing ? null : (
        <div className="flex gap-2">
          <Button
            disabled={locked}
            onClick={startEdit}
            size="sm"
            type="button"
            variant="outline"
          >
            Edit
          </Button>
          <ConfirmButton
            confirmLabel="Forget"
            description={`"${note.text}" will be removed from what the agent remembers.`}
            disabled={locked}
            onConfirm={forget}
            size="sm"
            title="Forget this note?"
            type="button"
            variant="outline"
          >
            Forget
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}

export function HeldRow({
  busy,
  change,
  disabled,
  onDecide,
}: {
  busy: boolean;
  change: MemoryChange;
  disabled: boolean;
  onDecide: (changeId: string, decision: "approve" | "reject") => void;
}): ReactElement {
  const locked = disabled || busy;
  const approve = useCallback(
    () => onDecide(change.id, "approve"),
    [change.id, onDecide]
  );
  const reject = useCallback(
    () => onDecide(change.id, "reject"),
    [change.id, onDecide]
  );

  return (
    <div className="flex flex-col gap-1 py-2" data-testid="held-row">
      <p className="font-medium text-sm">{heldLead(change.action)}</p>
      <p>{change.text}</p>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <Badge variant="secondary">Waiting for you</Badge>
        {change.userScope === null ? null : (
          <Badge data-testid="private-marker" variant="secondary">
            Private
          </Badge>
        )}
        <span>{WRITER_LABELS[change.writtenBy]}</span>
      </div>
      <div className="flex gap-2">
        <Button disabled={locked} onClick={approve} size="sm" type="button">
          Approve
        </Button>
        <Button
          disabled={locked}
          onClick={reject}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
    </div>
  );
}
