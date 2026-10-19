import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
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

export function ArchiveAgentDialog({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const archive = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await getTrpc().agents.archive.mutate({ id: agentId });
      toast.success(`Archived ${agentName}`);
      await router.invalidate();
      await router.navigate({ to: "/agents" });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  }, [agentId, agentName, router]);

  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {agentName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The agent is archived and no longer shows in the agent list. Its
            past sessions stay in the Log.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === undefined ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button disabled={pending} onClick={archive} variant="destructive">
            Archive
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
