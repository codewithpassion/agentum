import { useCallback, useEffect, useRef } from "react";
import { Button } from "./button";

/**
 * Native `<dialog>`: focus trapping, Escape handling and inertness of the page
 * behind it come from the platform rather than from a dependency.
 */
export function Dialog({
  children,
  onClose,
  open,
  title,
}: {
  children: React.ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the ref is null until the dialog mounts
    if (!element) {
      return;
    }
    if (open && !element.open) {
      element.showModal();
    }
    if (!open && element.open) {
      element.close();
    }
  }, [open]);

  const cancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      onClose();
    },
    [onClose]
  );

  return (
    <dialog
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-[var(--ws-line)] bg-[var(--ws-panel)] p-0 text-[var(--ws-text)] shadow-2xl backdrop:bg-black/60"
      onCancel={cancel}
      onClose={onClose}
      ref={ref}
    >
      <div className="flex items-center justify-between gap-3 border-[var(--ws-line)] border-b px-4 py-3">
        <h2 className="m-0 font-semibold text-sm">{title}</h2>
        <Button
          aria-label="Close"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}
