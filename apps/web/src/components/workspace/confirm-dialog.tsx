import { useCallback, useState } from "react";
import { Button, type ButtonProps } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

/** The dialog's contents, apart from its state so the busy and error looks can be rendered on their own. */
export function ConfirmBody({
  busy,
  confirmLabel,
  confirmVariant = "danger",
  error,
  message,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  confirmLabel: string;
  confirmVariant?: ButtonProps["variant"];
  error: string | null;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const label = busy ? "Working…" : confirmLabel;
  return (
    <>
      <p className="m-0 text-sm">{message}</p>
      {error ? (
        <p
          className="mt-3 mb-0 rounded-lg border border-[var(--ws-danger)] px-3 py-2 text-[var(--ws-danger)] text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel} variant="ghost">
          Cancel
        </Button>
        <Button
          aria-busy={busy}
          disabled={busy}
          onClick={onConfirm}
          variant={confirmVariant}
        >
          {label}
        </Button>
      </div>
    </>
  );
}

export function ConfirmDialog({
  confirmLabel,
  confirmVariant = "danger",
  message,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  confirmLabel: string;
  confirmVariant?: ButtonProps["variant"];
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
    setError(null);
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
      <ConfirmBody
        busy={busy}
        confirmLabel={confirmLabel}
        confirmVariant={confirmVariant}
        error={error}
        message={message}
        onCancel={onCancel}
        onConfirm={onConfirmClick}
      />
    </Dialog>
  );
}
