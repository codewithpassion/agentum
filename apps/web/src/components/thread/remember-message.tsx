import {
  MEMORY_NOTE_KINDS,
  MEMORY_NOTE_MAX_CHARS,
  type MemoryNoteKind,
} from "@repo/db/shared";
import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

const KIND_LABELS: Record<MemoryNoteKind, string> = {
  corrections: "Corrections",
  people: "People",
  places: "Places",
  work: "Work",
};

export const REMEMBER_KINDS: readonly {
  value: MemoryNoteKind;
  label: string;
}[] = MEMORY_NOTE_KINDS.map((value) => ({ label: KIND_LABELS[value], value }));

const DEFAULT_KIND: MemoryNoteKind = "work";
const WHITESPACE_RUN = /\s+/g;
// A clip can end on the first half of a surrogate pair. Drop that half.
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/** A message as one note: whitespace runs become one space, clipped to the note limit. */
export const rememberDefaultText = (messageText: string): string => {
  const oneLine = messageText.replace(WHITESPACE_RUN, " ").trim();
  return oneLine
    .slice(0, MEMORY_NOTE_MAX_CHARS)
    .replace(TRAILING_HIGH_SURROGATE, "")
    .trim();
};

const findKind = (value: string): MemoryNoteKind | undefined =>
  REMEMBER_KINDS.find((kind) => kind.value === value)?.value;

export function RememberForm({
  agentId,
  sessionId,
  messageText,
  onClose,
  onSaved,
}: {
  agentId: string;
  sessionId: string;
  messageText: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(() => rememberDefaultText(messageText));
  const [kind, setKind] = useState<MemoryNoteKind>(DEFAULT_KIND);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setText(event.target.value);
    },
    []
  );

  const handleKindChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = findKind(event.target.value);
      if (next !== undefined) {
        setKind(next);
      }
    },
    []
  );

  const remember = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().memory.add.mutate({
        agentId,
        kind,
        source: { id: sessionId, kind: "session" },
        text: text.trim(),
      });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [agentId, kind, onClose, onSaved, sessionId, text]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="remember-text">Note</Label>
        <Textarea
          data-testid="remember-text"
          id="remember-text"
          onChange={handleTextChange}
          value={text}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="remember-kind">Kind</Label>
        <NativeSelect
          data-testid="remember-kind"
          id="remember-kind"
          onChange={handleKindChange}
          value={kind}
        >
          {REMEMBER_KINDS.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          data-testid="remember-submit"
          disabled={pending || text.trim().length === 0}
          onClick={remember}
        >
          Remember
        </Button>
        <Button onClick={onClose} variant="outline">
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}

export function RememberDialog({
  agentId,
  sessionId,
  messageText,
  open,
  onOpenChange,
  onSaved,
}: {
  agentId: string;
  sessionId: string;
  messageText: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remember this</DialogTitle>
        </DialogHeader>
        {/* Radix unmounts the content when the dialog closes, so the form
            starts from the message text each time it opens. */}
        <RememberForm
          agentId={agentId}
          messageText={messageText}
          onClose={handleClose}
          onSaved={onSaved}
          sessionId={sessionId}
        />
      </DialogContent>
    </Dialog>
  );
}
