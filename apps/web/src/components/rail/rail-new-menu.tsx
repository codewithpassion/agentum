import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NewTaskDialog } from "#/components/desk/new-task-dialog";
import { Button } from "#/components/ui/button";
import { RailLink, useGo } from "./rail-link.tsx";

/** Below `md` a header action is a square icon button, its label hidden. */
export const ACTION_BUTTON_CLASS = "max-md:size-10 max-md:px-0";

/**
 * Closes the menu on Escape and on a press outside `ref`. It stays out of the
 * way while the New task dialog is open: the dialog renders in a portal, so
 * its clicks and its Escape would otherwise read as outside and unmount it.
 */
function useDismiss(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
  dialogOpen: boolean,
  close: () => void
) {
  useEffect(() => {
    if (!active || dialogOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [active, close, dialogOpen, ref]);
}

/**
 * The New button and the small menu under it: New task, New agent. The menu is
 * a panel anchored under the button rather than a popover, because
 * NewTaskDialog carries its own trigger and a popover would unmount it as the
 * dialog opens.
 */
export function RailNewMenu({
  agents,
  onNavigate,
}: {
  agents: readonly { id: string; name: string }[];
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const go = useGo();
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(wrapperRef, open, dialogOpen, close);
  const handleStarted = useCallback(
    (runId: string) => {
      setOpen(false);
      setDialogOpen(false);
      onNavigate();
      go(`/tasks/${encodeURIComponent(runId)}`);
    },
    [go, onNavigate]
  );
  const handleNewAgent = useCallback(() => {
    close();
    onNavigate();
  }, [close, onNavigate]);

  return (
    <div className="relative" ref={wrapperRef}>
      <Button
        aria-expanded={open}
        aria-label="New"
        className={ACTION_BUTTON_CLASS}
        onClick={toggle}
        type="button"
      >
        <Plus />
        <span className="max-md:hidden">New</span>
      </Button>
      {open ? (
        <div className="absolute top-full right-0 z-50 mt-2 flex w-44 flex-col gap-1 rounded-lg border border-border bg-card p-1 shadow-md">
          <NewTaskDialog
            agents={agents}
            onOpenChange={setDialogOpen}
            onStarted={handleStarted}
            triggerLabel="New task"
          />
          <RailLink
            className="flex min-h-10 items-center justify-center rounded-lg px-2.5 text-sm no-underline hover:bg-muted md:min-h-8"
            href="/agents/new"
            onNavigate={handleNewAgent}
          >
            New agent
          </RailLink>
        </div>
      ) : null}
    </div>
  );
}
