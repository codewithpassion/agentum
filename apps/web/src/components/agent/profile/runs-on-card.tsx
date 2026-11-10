import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import type { AgentProfileView } from "#/integrations/trpc/types";
import { MoveAgentDialog } from "./move-agent-dialog.tsx";
import { currentRuntime } from "./profile-logic.ts";

/** The "Runs on" side card: the agent's runtime as a fact. Information only. */
export function RunsOnCard({
  header,
  onAdvanced,
}: {
  header: AgentProfileView["header"];
  onAdvanced: () => void;
}) {
  const runtime = currentRuntime(header.runtime, header.machine);
  const [moving, setMoving] = useState(false);
  const openMove = useCallback(() => setMoving(true), []);
  const closeMove = useCallback(() => setMoving(false), []);
  return (
    <section
      aria-label="Runs on"
      className="min-w-0 flex-[1_1_240px] rounded-lg border border-border bg-card p-4"
    >
      <h2 className="font-semibold text-foreground text-sm">Runs on</h2>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-sm">{runtime.title}</span>
        {runtime.machineState === null ? null : (
          <span
            className={`rounded-full px-2 py-0.5 font-semibold text-xs ${
              runtime.machineState === "Online"
                ? "bg-success/15 text-success"
                : "bg-warning/15 text-warning"
            }`}
          >
            {runtime.machineState}
          </span>
        )}
      </div>
      <p className="mt-1 text-muted-foreground text-xs">{runtime.text}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={openMove} variant="outline">
          Move agent
        </Button>
        <Button onClick={onAdvanced} variant="outline">
          Advanced
        </Button>
      </div>
      {moving ? <MoveAgentDialog header={header} onClose={closeMove} /> : null}
    </section>
  );
}
