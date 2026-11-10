import {
  CLOUD_DEFAULT_MODEL,
  CLOUD_MODELS,
  cloudModelRef,
} from "@repo/services/cloud/models";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AgentProfileView,
  MachineRecord,
} from "#/integrations/trpc/types";
import {
  hostMachines,
  MOVE_COST,
  MOVE_TARGETS,
  type MoveTarget,
  moveBlocker,
  needsAnthropicModel,
} from "./move-agent-logic.ts";

const ANTHROPIC_MODELS = CLOUD_MODELS.filter(
  (entry) => entry.provider === "anthropic"
);

interface MoveData {
  hasAnthropicKey: boolean;
  hosts: MachineRecord[];
}

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Moves the agent to another runtime. The server refuses while a run is live and names the run. */
export function MoveAgentDialog({
  header,
  onClose,
}: {
  header: AgentProfileView["header"];
  onClose: () => void;
}) {
  const router = useRouter();
  const targets = MOVE_TARGETS.filter((entry) => entry.id !== header.runtime);
  const [target, setTarget] = useState<MoveTarget>(targets[0]?.id ?? "cloud");
  const [machineId, setMachineId] = useState("");
  const [model, setModel] = useState(CLOUD_DEFAULT_MODEL);
  const [data, setData] = useState<MoveData | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    Promise.all([
      getTrpc().machines.list.query(),
      getTrpc().managedKeys.status.query(),
    ])
      .then(([machines, key]) => {
        if (active) {
          const hosts = hostMachines(machines);
          setData({ hasAnthropicKey: key.configured, hosts });
          setMachineId(hosts[0]?.id ?? "");
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(messageOf(cause));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const blocker = data ? moveBlocker({ ...data, target }) : null;
  const askModel = needsAnthropicModel(target, header.model);

  const handleTarget = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setTarget(event.target.value as MoveTarget),
    []
  );
  const handleMachine = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setMachineId(event.target.value),
    []
  );
  const handleModel = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setModel(event.target.value),
    []
  );
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!(open || pending)) {
        onClose();
      }
    },
    [onClose, pending]
  );

  const move = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      await getTrpc().agents.changeRuntime.mutate({
        id: header.id,
        runtime: target,
        ...(target === "machine" ? { machineId } : {}),
        ...(askModel ? { model } : {}),
      });
      toast.success(`Moved ${header.name}`);
      await router.invalidate();
      onClose();
    } catch (cause: unknown) {
      setError(messageOf(cause));
      setPending(false);
    }
  }, [
    askModel,
    header.id,
    header.name,
    machineId,
    model,
    onClose,
    router,
    target,
  ]);

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {header.name}</DialogTitle>
          <DialogDescription>{MOVE_COST}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="move-target">Move to</Label>
          <NativeSelect id="move-target" onChange={handleTarget} value={target}>
            {targets.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {target === "machine" && data && data.hosts.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="move-machine">Machine</Label>
            <NativeSelect
              id="move-machine"
              onChange={handleMachine}
              value={machineId}
            >
              {data.hosts.map((host) => (
                <NativeSelectOption key={host.id} value={host.id}>
                  {host.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        {askModel ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="move-model">Model</Label>
            <NativeSelect id="move-model" onChange={handleModel} value={model}>
              {ANTHROPIC_MODELS.map((entry) => (
                <NativeSelectOption key={entry.id} value={cloudModelRef(entry)}>
                  {entry.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-muted-foreground text-xs">
              This runtime runs Anthropic models only, and the current model is
              not one.
            </p>
          </div>
        ) : null}
        {blocker === null ? null : (
          <p className="text-sm" role="alert">
            {blocker.text}{" "}
            <Link className="underline" to={blocker.fix.to}>
              {blocker.fix.label}
            </Link>
          </p>
        )}
        {error === undefined ? null : (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              pending ||
              data === undefined ||
              blocker !== null ||
              (target === "machine" && machineId === "")
            }
            onClick={move}
          >
            Move agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
