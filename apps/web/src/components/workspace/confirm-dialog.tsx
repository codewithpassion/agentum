import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

export function ConfirmDialog({
  confirmLabel,
  message,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  confirmLabel: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  open: boolean;
  title: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runConfirm = useCallback(async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }, [onConfirm]);

  const onConfirmClick = useCallback(() => {
    runConfirm();
  }, [runConfirm]);

  return (
    <Dialog onClose={onCancel} open={open} title={title}>
      <p className="m-0 text-sm">{message}</p>
      {error ? (
        <p className="mt-2 mb-0 text-[var(--ws-danger)] text-xs">{error}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel} variant="ghost">
          Cancel
        </Button>
        <Button disabled={busy} onClick={onConfirmClick} variant="danger">
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
