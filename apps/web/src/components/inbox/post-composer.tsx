import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { SendHint } from "#/components/composer/send-hint";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut";
import { StickyComposer } from "#/components/composer/sticky-composer";
import { canSend } from "#/components/inbox/inbox-logic";
import { errorMessage } from "#/components/triggers/format";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { getTrpc } from "#/integrations/trpc/client";

interface PostComposerProps {
  onSent: () => void;
  threadId: string;
}

export function PostComposer({ onSent, threadId }: PostComposerProps) {
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
      if (!canSend(text, sending)) {
        return;
      }
      setSending(true);
      setError(null);
      try {
        await getTrpc().inbox.post.mutate({ text: text.trim(), threadId });
        setText("");
        onSent();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setSending(false);
      }
    },
    [text, sending, threadId, onSent]
  );

  return (
    <StickyComposer background="bg-background">
      <form
        className="flex flex-col gap-2 md:border-t md:pt-4"
        onSubmit={handleSubmit}
      >
        <Label htmlFor={textId}>Message</Label>
        <Textarea
          aria-describedby={hintId}
          id={textId}
          onChange={handleChange}
          onKeyDown={submitOnSendShortcut}
          value={text}
        />
        <p className="text-muted-foreground text-xs" id={hintId}>
          Mention an agent with @slug to start a run.
        </p>
        <div className="flex items-center gap-2">
          <Button disabled={!canSend(text, sending)} type="submit">
            Send
          </Button>
          <SendHint />
        </div>
        {error === null ? null : (
          <p className="text-destructive text-sm">{error}</p>
        )}
      </form>
    </StickyComposer>
  );
}
