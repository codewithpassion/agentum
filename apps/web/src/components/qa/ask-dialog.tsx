import { QA_BODY_MAX, QA_TITLE_MAX } from "@repo/db/shared";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { SubmitKeys } from "#/components/composer/submit-keys";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
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
import { errorMessage } from "#/lib/error-message";
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

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled: !open || sending,
    getValue: () => body,
    inputRef,
    setValue: setBody,
  });
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
      if (!canSubmitQuestion(title, body, sending || dictation.busy)) {
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
    [title, body, sending, dictation.busy, onAsked]
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
            <div className="relative">
              <Textarea
                id={bodyId}
                maxLength={QA_BODY_MAX}
                onChange={handleBodyChange}
                onKeyDown={submitOnSendShortcut}
                readOnly={dictation.busy}
                ref={inputRef}
                value={body}
              />
              <DictationPreview dictation={dictation} />
            </div>
            <DictationButton dictation={dictation} />
          </div>
          <Button
            disabled={
              !canSubmitQuestion(title, body, sending || dictation.busy)
            }
            type="submit"
          >
            Ask
            <SubmitKeys />
          </Button>
          {error === null ? null : (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
