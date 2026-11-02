import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { switchErrorMessage } from "./workspace-menu-logic.ts";

/** Asks for a name, makes the workspace, and hands its organisation id to `onCreated`. */
export function NewWorkspaceDialog({
  onCreated,
  onOpenChange,
  open,
}: {
  onCreated: (clerkOrgId: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const canCreate = name.trim() !== "" && !pending;

  const handleName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );
  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canCreate) {
        return;
      }
      setPending(true);
      setError(null);
      try {
        const { clerkOrgId } = await getTrpc().workspaces.create.mutate({
          name,
        });
        // The page reloads once the switch lands, so the dialog stays pending.
        await onCreated(clerkOrgId);
      } catch (caught) {
        setError(switchErrorMessage(caught));
        setPending(false);
      }
    },
    [canCreate, name, onCreated]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              autoComplete="off"
              id={nameId}
              maxLength={80}
              onChange={handleName}
              value={name}
            />
          </div>
          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={!canCreate} type="submit">
              {pending ? "Creating" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
