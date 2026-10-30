import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { NewTaskDialog } from "#/components/desk/new-task-dialog";
import { Button } from "#/components/ui/button";
import { RailLink, useGo } from "./rail-link.tsx";

/**
 * The New button and the small menu under it: New task, New agent. The menu is
 * a panel in the rail rather than a popover, because NewTaskDialog carries its
 * own trigger and a popover would unmount it as the dialog opens.
 */
export function RailNewMenu({
  agents,
  onNavigate,
}: {
  agents: readonly { id: string; name: string }[];
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const go = useGo();
  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);
  const handleStarted = useCallback(
    (runId: string) => {
      setOpen(false);
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
    <>
      <Button aria-expanded={open} onClick={toggle} type="button">
        <Plus data-icon="inline-start" />
        New
      </Button>
      {open ? (
        <div className="flex basis-full flex-col gap-1 rounded-lg border border-border bg-card p-1">
          <NewTaskDialog
            agents={agents}
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
    </>
  );
}
