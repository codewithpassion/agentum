import type { DreamNeedsYou } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { errorMessage } from "#/lib/error-message";

const TWO_OPTIONS = 2;

/** One note the dream could keep: its text and the button that keeps it. */
function DreamOption({
  disabled,
  noteId,
  onKeep,
  text,
}: {
  disabled: boolean;
  noteId: string;
  onKeep: (noteId: string) => Promise<void>;
  text: string;
}) {
  const keep = useCallback(async () => {
    await onKeep(noteId);
  }, [noteId, onKeep]);

  return (
    <li
      className="flex flex-col items-start gap-2 rounded-lg border p-3"
      data-testid="dream-option"
    >
      <p className="[overflow-wrap:anywhere]">{text}</p>
      <Button
        aria-label={`Keep this one: ${text}`}
        disabled={disabled}
        onClick={keep}
        type="button"
        variant="outline"
      >
        Keep this one
      </Button>
    </li>
  );
}

/** The contradiction a dream could not settle: the question, and one button per note to keep. */
export function DreamQuestionBody({
  dream,
  onAnswer,
}: {
  dream: DreamNeedsYou;
  onAnswer: (questionId: string, noteId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { options, questionId } = dream;
  const answer = useCallback(
    async (noteId: string) => {
      setPending(true);
      setError(null);
      try {
        await onAnswer(questionId, noteId);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [onAnswer, questionId]
  );
  const summary =
    options.length === TWO_OPTIONS
      ? "These two notes disagree. Keep the one that is right and the dream drops the other."
      : "These notes disagree. Keep the one that is right and the dream drops the others.";

  return (
    <div className="flex flex-col gap-3" data-testid="dream-question-body">
      <p>{dream.question}</p>
      <p className="text-muted-foreground text-sm">{summary}</p>
      <ul className="flex flex-col gap-3">
        {options.map((option) => (
          <DreamOption
            disabled={pending}
            key={option.noteId}
            noteId={option.noteId}
            onKeep={answer}
            text={option.text}
          />
        ))}
      </ul>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
