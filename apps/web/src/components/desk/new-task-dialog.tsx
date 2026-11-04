import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { dictationAdapter } from "#/components/composer/dictation-adapter.ts";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut.ts";
import { SubmitKeys } from "#/components/composer/submit-keys.tsx";
import {
  DictationButton,
  DictationPreview,
  useDictation,
} from "#/components/dictation/index.ts";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { getTrpc } from "#/integrations/trpc/client";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

/** Starts a task for an agent and reports the new run's id. */
export function NewTaskDialog({
  agents,
  onOpenChange,
  onStarted,
  triggerLabel = "+ New task",
}: {
  agents: readonly { id: string; name: string }[];
  /** Called when the dialog opens or closes, for a parent that must stay mounted while it is open. */
  onOpenChange?: (open: boolean) => void;
  onStarted: (runId: string) => void;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [agentChoice, setAgentChoice] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentSelectId = useId();
  const textId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    adapter: dictationAdapter,
    disabled: !open || pending,
    getValue: () => text,
    inputRef,
    setValue: setText,
  });

  // Falls back to the first agent until the user picks one.
  const agentId = agents.some((agent) => agent.id === agentChoice)
    ? agentChoice
    : (agents[0]?.id ?? "");
  const canStart =
    text.trim() !== "" && agentId !== "" && !pending && !dictation.busy;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  const handleAgentChange = useCallback((next: string) => {
    setAgentChoice(next);
  }, []);

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setText(event.target.value);
    },
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canStart) {
        return;
      }
      setPending(true);
      setError(null);
      try {
        const result = await getTrpc().runs.start.mutate({
          agentId,
          input: { fileIds: [], text: text.trim() },
          requestId: crypto.randomUUID(),
          session: { origin: "ui" },
        });
        setText("");
        setAgentChoice("");
        setOpen(false);
        onStarted(result.runId);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [agentId, canStart, onStarted, text]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>
        {agents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Create an agent first.
          </p>
        ) : (
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor={agentSelectId}>Agent</Label>
              <Select onValueChange={handleAgentChange} value={agentId}>
                <SelectTrigger id={agentSelectId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={textId}>What should it do?</Label>
              <div className="relative">
                <Textarea
                  className="max-h-[60dvh] min-h-40 sm:min-h-64"
                  id={textId}
                  onChange={handleTextChange}
                  onKeyDown={submitOnSendShortcut}
                  readOnly={dictation.busy}
                  ref={inputRef}
                  value={text}
                />
                <DictationPreview dictation={dictation} />
              </div>
              <DictationButton dictation={dictation} />
              {error === null ? null : (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button disabled={!canStart} type="submit">
                Start task
                <SubmitKeys />
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
