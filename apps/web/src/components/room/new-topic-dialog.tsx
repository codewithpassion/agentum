import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { InboxThread } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { canCreateTopic, newTopicInput } from "./new-topic-logic.ts";
import { memberKey, type RoomMember } from "./room-types.ts";

interface NewTopicDialogProps {
  members: readonly RoomMember[];
  onCreated: (thread: InboxThread) => void;
  teamId: string;
}

interface MemberOptionProps {
  checked: boolean;
  id: string;
  member: RoomMember;
  onToggle: (key: string, checked: boolean) => void;
}

function MemberOption({ checked, id, member, onToggle }: MemberOptionProps) {
  const key = memberKey(member.kind, member.id);
  const handleCheckedChange = useCallback(
    (next: boolean | "indeterminate") => onToggle(key, next === true),
    [key, onToggle]
  );
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        id={id}
        onCheckedChange={handleCheckedChange}
      />
      <Label htmlFor={id}>
        {member.name}
        <span className="font-normal text-muted-foreground">
          {member.kind === "agent" ? "agent" : "person"}
        </span>
      </Label>
    </div>
  );
}

export function NewTopicDialog({
  members,
  onCreated,
  teamId,
}: NewTopicDialogProps) {
  const idBase = useId();
  const titleId = `${idBase}-title`;
  const hintId = `${idBase}-hint`;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
    []
  );

  const handleToggle = useCallback((key: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canCreateTopic(title, creating)) {
        return;
      }
      setCreating(true);
      setError(null);
      try {
        const thread = await getTrpc().inbox.createThread.mutate(
          newTopicInput({ members, selected, teamId, title })
        );
        setTitle("");
        setSelected(new Set());
        setOpen(false);
        onCreated(thread);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setCreating(false);
      }
    },
    [creating, members, onCreated, selected, teamId, title]
  );

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          New topic
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New topic</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              maxLength={120}
              onChange={handleTitleChange}
              required
              value={title}
            />
          </div>
          {members.length === 0 ? null : (
            <fieldset aria-describedby={hintId} className="flex flex-col gap-2">
              <legend className="font-medium text-sm">
                Only these members (optional)
              </legend>
              <p className="text-muted-foreground text-sm" id={hintId}>
                Leave all unticked to open the topic to the whole team. You are
                always in it.
              </p>
              {members.map((member) => {
                const key = memberKey(member.kind, member.id);
                return (
                  <MemberOption
                    checked={selected.has(key)}
                    id={`${idBase}-${key}`}
                    key={key}
                    member={member}
                    onToggle={handleToggle}
                  />
                );
              })}
            </fieldset>
          )}
          <Button disabled={!canCreateTopic(title, creating)} type="submit">
            Create topic
          </Button>
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
