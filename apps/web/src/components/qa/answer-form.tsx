import { QA_BODY_MAX } from "@repo/db/shared";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { SendHint } from "#/components/composer/send-hint";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { errorMessage } from "#/components/triggers/format";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import { canSubmitAnswer } from "./qa-logic.ts";

interface AnswerFormProps {
  onAnswered: () => void;
  questionId: string;
}

export function AnswerForm({ onAnswered, questionId }: AnswerFormProps) {
  const textId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmitAnswer(text, sending)) {
        return;
      }
      setSending(true);
      setError(null);
      try {
        await getTrpc().qa.answer.mutate({
          body: text.trim(),
          questionId,
        });
        setText("");
        onAnswered();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSending(false);
      }
    },
    [text, sending, questionId, onAnswered]
  );

  return (
    <form className="flex flex-col gap-2 border-t pt-4" onSubmit={handleSubmit}>
      <Label htmlFor={textId}>Your answer</Label>
      <Textarea
        aria-describedby={hintId}
        id={textId}
        maxLength={QA_BODY_MAX}
        onChange={handleChange}
        onKeyDown={submitOnSendShortcut}
        value={text}
      />
      <div className="flex items-center gap-2">
        <Button disabled={!canSubmitAnswer(text, sending)} type="submit">
          Post answer
        </Button>
        <SendHint id={hintId} />
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
    </form>
  );
}
