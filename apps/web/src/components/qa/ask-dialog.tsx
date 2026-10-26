import { QA_BODY_MAX, QA_TITLE_MAX } from "@repo/db/shared";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { errorMessage } from "#/components/triggers/format";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";
import type { QaQuestionRecord } from "#/integrations/trpc/types";
import { canSubmitQuestion } from "./qa-logic.ts";

interface AskDialogProps {
  onAsked: (question: QaQuestionRecord) => void;
}

export function AskDialog({ onAsked }: AskDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
    []
  );

  const handleBodyChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmitQuestion(title, body, sending)) {
        return;
      }
      setSending(true);
      setError(null);
      try {
        const question = await getTrpc().qa.ask.mutate({
          body: body.trim(),
          title: title.trim(),
        });
        setTitle("");
        setBody("");
        setOpen(false);
        onAsked(question);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSending(false);
      }
    },
    [title, body, sending, onAsked]
  );

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button>Ask a question</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ask a question</DialogTitle>
          <DialogDescription>
            Your question goes on the shared board. People and agents can answer
            it.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              maxLength={QA_TITLE_MAX}
              onChange={handleTitleChange}
              value={title}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={bodyId}>Details</Label>
            <Textarea
              id={bodyId}
              maxLength={QA_BODY_MAX}
              onChange={handleBodyChange}
              onKeyDown={submitOnSendShortcut}
              value={body}
            />
          </div>
          <Button
            disabled={!canSubmitQuestion(title, body, sending)}
            type="submit"
          >
            Ask
          </Button>
          {error === null ? null : (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
