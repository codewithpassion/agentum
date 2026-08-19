import { useEffect, useRef } from "react";
import { cx } from "#/lib/cx";

/**
 * Anchored panel that closes on outside pointer-down and Escape. Positioning is
 * left to the caller (the wrapper is `relative`), which keeps it trivial for the
 * two places we need it: the sidebar "＋" menu and the mention autocomplete.
 */
export function Popover({
  align = "left",
  children,
  className,
  onClose,
  open,
}: {
  align?: "left" | "right";
  children: React.ReactNode;
  className?: string;
  onClose: () => void;
  open: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className={cx(
        "absolute z-30 min-w-44 overflow-hidden rounded-xl border border-[var(--ws-line)] bg-[var(--ws-panel)] p-1 shadow-xl",
        align === "right" ? "right-0" : "left-0",
        className
      )}
      ref={ref}
    >
      {children}
    </div>
  );
}
