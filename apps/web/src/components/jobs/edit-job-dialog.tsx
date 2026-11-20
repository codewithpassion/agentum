import type { JobSentence } from "@repo/db/shared";
import { RoutinesPanel } from "#/components/agent/profile/sheets/routines.tsx";
import { TriggersPanel } from "#/components/agent/profile/sheets/triggers.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import type { AgentRecord } from "#/integrations/trpc/types.ts";

/**
 * Edits a job through the agent's own Routines or Triggers panel, which hold
 * the forms to change, pause, remove or add one.
 */
export function EditJobDialog({
  agent,
  job,
  onOpenChange,
}: {
  agent: AgentRecord;
  job: JobSentence;
  onOpenChange: (open: boolean) => void;
}) {
  const isRoutine = job.source === "routine";
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Edit job</DialogTitle>
          <DialogDescription>
            {isRoutine
              ? `The routines of ${agent.name}. Pause, remove or create one here.`
              : `The web triggers of ${agent.name}. Pause, revoke or create one here.`}
          </DialogDescription>
        </DialogHeader>
        {isRoutine ? (
          <RoutinesPanel agent={agent} />
        ) : (
          <TriggersPanel agent={agent} />
        )}
      </DialogContent>
    </Dialog>
  );
}
