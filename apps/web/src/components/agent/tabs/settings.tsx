import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentForm, type AgentFormValues } from "#/components/agent/agent-form";
import { getTrpc } from "#/integrations/trpc/client";
import type { MachineRecord } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";

function SettingsPanel({ agent }: AgentTabProps) {
  const router = useRouter();
  const [machines, setMachines] = useState<MachineRecord[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    getTrpc()
      .machines.list.query()
      .then((items) => {
        if (active) {
          setMachines(items);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(
    async (values: AgentFormValues) => {
      await getTrpc().agents.update.mutate({
        id: agent.id,
        patch: {
          instructions: values.instructions,
          model: values.model,
          name: values.name,
          ...(agent.runtime === "machine"
            ? { machineId: values.machineId }
            : {}),
        },
      });
      await router.invalidate();
      toast.success("Saved");
    },
    [agent.id, agent.runtime, router]
  );

  let body: ReactNode;
  if (error !== undefined) {
    body = <p className="text-destructive text-sm">{error}</p>;
  } else if (machines === undefined) {
    body = <p className="text-muted-foreground text-sm">Loading settings.</p>;
  } else {
    body = (
      <AgentForm
        initial={{
          instructions: agent.instructions,
          machineId: agent.machineId ?? "",
          model: agent.model,
          name: agent.name,
          runtime: agent.runtime,
        }}
        key={agent.id}
        lockRuntime
        machines={machines}
        onSubmit={save}
        submitLabel="Save changes"
      />
    );
  }

  return <section className="max-w-3xl">{body}</section>;
}

export const settingsTab: AgentTab = {
  id: "settings",
  label: "Settings",
  Panel: SettingsPanel,
};
