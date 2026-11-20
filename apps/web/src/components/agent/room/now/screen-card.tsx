import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { DesktopScreen } from "#/components/computer/desktop-screen.tsx";
import { takeoverControls } from "#/components/task/slots.tsx";
import type { TakeoverRequest } from "#/components/task/task-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { errorMessage } from "#/lib/error-message.ts";

/** The Screen card of the Right now panel: watch the agent's computer, and take it over when the agent asks. */
export function ScreenCard({
  agentName,
  machineId,
  takeover,
}: {
  agentName: string;
  /** The agent's computer, null when it has none. */
  machineId: string | null;
  /** The running task's open takeover request, null when the agent has not asked for a person. */
  takeover: TakeoverRequest | null;
}) {
  const [watching, setWatching] = useState(false);
  const [taking, setTaking] = useState(false);
  const controls = useMemo(
    () => (takeover === null ? null : takeoverControls(takeover)),
    [takeover]
  );

  const toggleWatch = useCallback(() => setWatching((value) => !value), []);

  const takeOver = useCallback(async () => {
    if (controls === null) {
      return;
    }
    setTaking(true);
    try {
      await controls.take();
      setWatching(true);
    } catch (cause) {
      toast.error(errorMessage(cause, "Could not take over."));
    } finally {
      setTaking(false);
    }
  }, [controls]);

  if (machineId === null) {
    return null;
  }

  const takeDisabled = controls === null || taking;
  const hint =
    takeover === null
      ? `${agentName} has not asked for you.`
      : `${agentName} is waiting for you.`;

  return (
    <section
      aria-label="Screen"
      className="min-w-0 rounded-lg border border-border bg-card"
      data-testid="now-screen"
    >
      <h2 className="px-4 py-3 font-semibold text-sm">Screen</h2>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            aria-pressed={watching}
            className="pointer-coarse:min-h-10"
            onClick={toggleWatch}
            size="sm"
            type="button"
            variant="outline"
          >
            {watching ? "Stop watching" : "Watch"}
          </Button>
          <Button
            className="pointer-coarse:min-h-10"
            disabled={takeDisabled}
            onClick={takeOver}
            size="sm"
            type="button"
          >
            Take over
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{hint}</p>
        {watching ? (
          <DesktopScreen
            key={machineId}
            machineId={machineId}
            takeover={controls}
          />
        ) : null}
      </div>
    </section>
  );
}
