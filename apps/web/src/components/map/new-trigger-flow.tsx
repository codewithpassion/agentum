import { useCallback, useState } from "react";
import { CreateRoutineDialog } from "#/components/routines/create-routine-dialog.tsx";
import {
  type CreatedTrigger,
  CreateTriggerDialog,
} from "#/components/triggers/create-trigger-dialog.tsx";
import { TriggerSecretDialog } from "#/components/triggers/trigger-secret-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";

type Step = "choose" | "http" | "routine";

/**
 * "+ Trigger": choose what kind, then the app's own create dialog for it.
 * An HTTP trigger shows its secret once, so the flow stays open until that is
 * closed. `onDone` runs when the flow ends, whether or not something was made.
 */
export function NewTriggerFlow({
  agents,
  onDone,
}: {
  agents: readonly { id: string; name: string }[];
  onDone: (created: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [secret, setSecret] = useState<CreatedTrigger | null>(null);

  const cancel = useCallback(() => onDone(false), [onDone]);
  const chooseHttp = useCallback(() => setStep("http"), []);
  const chooseRoutine = useCallback(() => setStep("routine"), []);
  const handleChooseOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        onDone(false);
      }
    },
    [onDone]
  );
  const handleRoutineCreated = useCallback(() => onDone(true), [onDone]);
  const closeSecret = useCallback(() => onDone(true), [onDone]);

  if (secret !== null) {
    return (
      <TriggerSecretDialog
        onDone={closeSecret}
        secret={secret.secret}
        triggerId={secret.trigger.id}
      />
    );
  }
  if (step === "http") {
    return (
      <CreateTriggerDialog
        agents={agents}
        onClose={cancel}
        onCreated={setSecret}
      />
    );
  }
  if (step === "routine") {
    return (
      <CreateRoutineDialog
        agents={agents}
        onClose={cancel}
        onCreated={handleRoutineCreated}
      />
    );
  }
  return (
    <Dialog onOpenChange={handleChooseOpen} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New trigger</DialogTitle>
          <DialogDescription>
            What should start the agent? Mail and Slack are set up on the
            agent's profile.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button onClick={chooseHttp} variant="outline">
            HTTP trigger
          </Button>
          <Button onClick={chooseRoutine} variant="outline">
            Schedule
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
