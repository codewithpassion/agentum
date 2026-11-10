import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import type { InboxThread } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

interface NewThreadFormProps {
  onCreated: (thread: InboxThread) => void;
}

export function NewThreadForm({ onCreated }: NewThreadFormProps) {
  const titleId = useId();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (trimmed === "" || creating) {
        return;
      }
      setCreating(true);
      setError(null);
      try {
        const thread = await getTrpc().inbox.createThread.mutate({
          title: trimmed,
        });
        setTitle("");
        onCreated(thread);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setCreating(false);
      }
    },
    [trimmed, creating, onCreated]
  );

  return (
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <Label htmlFor={titleId}>Title</Label>
      <Input
        id={titleId}
        maxLength={120}
        onChange={handleChange}
        value={title}
      />
      <Button disabled={creating || trimmed === ""} type="submit">
        New thread
      </Button>
      {error === null ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
    </form>
  );
}
