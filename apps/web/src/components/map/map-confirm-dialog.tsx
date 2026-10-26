import { useCallback } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";

export interface ConfirmRequest {
  body: string;
  confirm: string;
  destructive: boolean;
  /** Runs when the person confirms. A throw shows its message in the dialog. */
  run: () => Promise<void>;
  title: string;
}

/** A confirm for an edit that cannot be undone from the map. */
export function MapConfirmDialog({
  error,
  onCancel,
  onConfirm,
  pending,
  request,
}: {
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  request: ConfirmRequest;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onCancel();
      }
    },
    [onCancel]
  );
  return (
    <AlertDialog onOpenChange={handleOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{request.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            disabled={pending}
            onClick={onConfirm}
            variant={request.destructive ? "destructive" : "default"}
          >
            {request.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
