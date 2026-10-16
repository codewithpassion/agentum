import { type ChangeEvent, useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { errorMessage } from "./format.ts";

export type CreatedTrigger = RouterOutputs["triggers"]["create"];

export interface AgentOption {
  id: string;
  name: string;
}

export function CreateTriggerDialog({
  agentId,
  agents = [],
  onClose,
  onCreated,
}: {
  /** Fixes the agent. When undefined, the dialog asks for one from `agents`. */
  agentId?: string;
  agents?: readonly AgentOption[];
  onClose: () => void;
  onCreated: (created: CreatedTrigger) => void;
}) {
  const [name, setName] = useState("");
  const [chosenAgentId, setChosenAgentId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetAgentId = agentId ?? chosenAgentId;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setName(event.target.value);
    },
    []
  );

  const handleAgentChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setChosenAgentId(event.target.value);
    },
    []
  );

  const createTrigger = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const created = await getTrpc().triggers.create.mutate({
        agentId: targetAgentId,
        name,
      });
      onCreated(created);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }, [name, onCreated, targetAgentId]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create trigger</DialogTitle>
          <DialogDescription>
            A trigger lets an outside system start a run of an agent over HTTP.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="trigger-name">Name</Label>
            <Input id="trigger-name" onChange={handleNameChange} value={name} />
          </div>
          {agentId === undefined ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trigger-agent">Agent</Label>
              <NativeSelect
                id="trigger-agent"
                onChange={handleAgentChange}
                value={chosenAgentId}
              >
                <NativeSelectOption value="">
                  Choose an agent
                </NativeSelectOption>
                {agents.map((agent) => (
                  <NativeSelectOption key={agent.id} value={agent.id}>
                    {agent.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {error !== null && (
            <p className="text-destructive text-sm">{error}</p>
          )}
          <DialogFooter>
            <Button
              disabled={
                pending || name.trim().length === 0 || targetAgentId === ""
              }
              onClick={createTrigger}
            >
              Create trigger
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
