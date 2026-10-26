import type { ModelProvider } from "@repo/db/shared";
import { cloudEnvironmentOf } from "@repo/services/cloud/environment";
import { networkAccessOf } from "@repo/services/cloud/network";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  maxTurnsInputOf,
  runtimeConfigOf,
} from "#/components/agent/agent-config.ts";
import { AgentForm, type AgentFormValues } from "#/components/agent/agent-form";
import { ArchiveAgentDialog } from "#/components/agent/archive-agent-dialog";
import { AskRules } from "#/components/agent/settings/ask-rules";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { MachineRecord } from "#/integrations/trpc/types";
import type { AgentTab, AgentTabProps } from "../agent-tabs.ts";

interface SettingsData {
  machines: MachineRecord[];
  providerKeys: Record<ModelProvider, boolean>;
}

function SettingsPanel({ agent }: AgentTabProps) {
  const router = useRouter();
  const [data, setData] = useState<SettingsData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [archiving, setArchiving] = useState(false);
  const openArchive = useCallback(() => setArchiving(true), []);
  const closeArchive = useCallback(() => setArchiving(false), []);

  useEffect(() => {
    let active = true;
    Promise.all([
      getTrpc().machines.list.query(),
      getTrpc().agents.providerKeys.query(),
    ])
      .then(([machines, providerKeys]) => {
        if (active) {
          setData({ machines, providerKeys });
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
          ...(agent.runtime === "cloud" || agent.runtime === "machine"
            ? { runtimeConfig: runtimeConfigOf(agent.runtimeConfig, values) }
            : {}),
        },
      });
      await router.invalidate();
      toast.success("Saved");
    },
    [agent.id, agent.runtime, agent.runtimeConfig, router]
  );

  let body: ReactNode;
  if (error !== undefined) {
    body = <p className="text-destructive text-sm">{error}</p>;
  } else if (data === undefined) {
    body = <p className="text-muted-foreground text-sm">Loading settings.</p>;
  } else {
    body = (
      <AgentForm
        initial={{
          environment: cloudEnvironmentOf(agent.runtimeConfig),
          instructions: agent.instructions,
          machineId: agent.machineId ?? "",
          maxTurns: maxTurnsInputOf(agent.runtimeConfig),
          model: agent.model,
          name: agent.name,
          networkAccess: networkAccessOf(agent.runtimeConfig),
          runtime: agent.runtime,
        }}
        key={agent.id}
        lockRuntime
        machines={data.machines}
        onSubmit={save}
        providerKeys={data.providerKeys}
        submitLabel="Save changes"
      />
    );
  }

  return (
    <section className="max-w-3xl">
      {body}
      <div className="mt-10 border-border border-t pt-6">
        <AskRules agentId={agent.id} />
      </div>
      <div className="mt-10 border-border border-t pt-6">
        <Button onClick={openArchive} variant="outline">
          Archive agent
        </Button>
      </div>
      {archiving ? (
        <ArchiveAgentDialog
          agentId={agent.id}
          agentName={agent.name}
          onClose={closeArchive}
        />
      ) : null}
    </section>
  );
}

export const settingsTab: AgentTab = {
  id: "settings",
  label: "Settings",
  Panel: SettingsPanel,
};
