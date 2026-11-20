import {
  MEMORY_NOTE_KINDS,
  MEMORY_NOTE_MAX_CHARS,
  type MemoryNoteKind,
} from "@repo/db/shared";
import type { ChangeEvent, FormEvent, ReactElement } from "react";
import { useCallback, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { HeldRow, NoteRow } from "./note-row.tsx";
import { KIND_LABELS, type NoteGroup } from "./notes-logic.ts";

function NoteGroupBlock({
  busyId,
  disabled,
  group,
  onDecide,
  onEdit,
  onForget,
}: {
  busyId: string | null;
  disabled: boolean;
  group: NoteGroup;
  onDecide: (changeId: string, decision: "approve" | "reject") => void;
  onEdit: (noteId: string, text: string) => void;
  onForget: (noteId: string) => void;
}): ReactElement {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-medium text-sm">{group.label}</h3>
      {group.held.map((change) => (
        <HeldRow
          busy={busyId === change.id}
          change={change}
          disabled={disabled}
          key={change.id}
          onDecide={onDecide}
        />
      ))}
      {group.notes.map((note) => (
        <NoteRow
          busy={busyId === note.id}
          disabled={disabled}
          key={note.id}
          note={note}
          onEdit={onEdit}
          onForget={onForget}
        />
      ))}
    </section>
  );
}

export function NotesSection({
  adding,
  busyId,
  disabled,
  groups,
  onAdd,
  onDecide,
  onEdit,
  onForget,
}: {
  busyId: string | null;
  disabled: boolean;
  groups: readonly NoteGroup[];
  onAdd: (kind: MemoryNoteKind, text: string) => void;
  onDecide: (changeId: string, decision: "approve" | "reject") => void;
  onEdit: (noteId: string, text: string) => void;
  onForget: (noteId: string) => void;
  adding: boolean;
}): ReactElement {
  const [kind, setKind] = useState<MemoryNoteKind>("people");
  const [text, setText] = useState("");
  const kindId = useId();
  const textId = useId();
  const trimmed = text.trim();
  const addDisabled = disabled || adding || trimmed === "";

  const changeKind = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const picked = MEMORY_NOTE_KINDS.find(
      (candidate) => candidate === event.target.value
    );
    if (picked !== undefined) {
      setKind(picked);
    }
  }, []);
  const changeText = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value);
  }, []);
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (addDisabled) {
        return;
      }
      onAdd(kind, trimmed);
      setText("");
    },
    [addDisabled, kind, onAdd, trimmed]
  );

  return (
    <div className="flex flex-col gap-4">
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing remembered yet.</p>
      ) : (
        groups.map((group) => (
          <NoteGroupBlock
            busyId={busyId}
            disabled={disabled}
            group={group}
            key={group.kind}
            onDecide={onDecide}
            onEdit={onEdit}
            onForget={onForget}
          />
        ))
      )}
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="font-medium text-sm">Add a note</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={kindId}>Kind</Label>
          <NativeSelect
            disabled={disabled}
            id={kindId}
            onChange={changeKind}
            value={kind}
          >
            {MEMORY_NOTE_KINDS.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {KIND_LABELS[option]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={textId}>Note</Label>
          <Input
            disabled={disabled}
            id={textId}
            maxLength={MEMORY_NOTE_MAX_CHARS}
            onChange={changeText}
            value={text}
          />
        </div>
        <div>
          <Button disabled={addDisabled} size="sm" type="submit">
            Add note
          </Button>
        </div>
      </form>
    </div>
  );
}
