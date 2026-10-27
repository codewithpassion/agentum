import { useCallback, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "#/components/library/library-logic.ts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";

export function DeleteSkillDialog({
  onClose,
  onDone,
  skill,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
  skill: { id: string; name: string };
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const remove = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await getTrpc().skillStore.remove.mutate({ skillId: skill.id });
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
      return;
    }
    toast.success(`Skill ${skill.name} deleted`);
    await onDone();
  }, [onDone, skill.id, skill.name]);

  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {skill.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Delete removes all its versions, files and assignments. It cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={pending} onClick={remove} variant="destructive">
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
