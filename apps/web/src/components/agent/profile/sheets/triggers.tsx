import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { CreatedTrigger } from "#/components/triggers/create-trigger-dialog";
import { CreateTriggerDialog } from "#/components/triggers/create-trigger-dialog";
import { errorMessage } from "#/components/triggers/format";
import { TriggerSecretDialog } from "#/components/triggers/trigger-secret-dialog";
import { TriggerTable } from "#/components/triggers/trigger-table";
import { Button } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import type { TriggerRecord } from "#/integrations/trpc/types";
import type { AgentPanelProps } from "./props.ts";

export function TriggersPanel({ agent }: AgentPanelProps) {
  const agentId = agent.id;
  const [triggers, setTriggers] = useState<TriggerRecord[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedTrigger | null>(null);
  const [secretTitle, setSecretTitle] = useState("Trigger created");

  const fetchTriggers = useCallback(
    () => getTrpc().triggers.list.query({ agentId }),
    [agentId]
  );

  useEffect(() => {
    let active = true;
    fetchTriggers()
      .then((items) => {
        if (active) {
          setTriggers(items);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [fetchTriggers]);

  const reload = useCallback(() => {
    fetchTriggers()
      .then((items) => {
        setTriggers(items);
        setError(undefined);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [fetchTriggers]);

  const openCreate = useCallback(() => setCreating(true), []);

  const closeCreate = useCallback(() => setCreating(false), []);

  const showSecret = useCallback((next: CreatedTrigger) => {
    setCreating(false);
    setSecretTitle("Trigger created");
    setCreated(next);
  }, []);

  const closeSecret = useCallback(() => {
    setCreated(null);
    reload();
  }, [reload]);

  const approveTrigger = useCallback(async (triggerId: string) => {
    setError(undefined);
    try {
      const approved = await getTrpc().triggers.approve.mutate({ triggerId });
      if (approved.secret === null) {
        setError("The approved trigger came back without a secret.");
        return;
      }
      setSecretTitle("Trigger approved");
      setCreated({ secret: approved.secret, trigger: approved.trigger });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  const rejectTrigger = useCallback(
    async (triggerId: string) => {
      try {
        await getTrpc().triggers.reject.mutate({ triggerId });
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
      reload();
    },
    [reload]
  );

  const revokeTrigger = useCallback(
    async (triggerId: string) => {
      try {
        await getTrpc().triggers.revoke.mutate({ triggerId });
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
      reload();
    },
    [reload]
  );

  const toggleTrigger = useCallback(
    async (triggerId: string, enabled: boolean) => {
      setError(undefined);
      try {
        await getTrpc().triggers.setEnabled.mutate({ enabled, triggerId });
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
      reload();
    },
    [reload]
  );

  let body: ReactNode;
  if (triggers === undefined) {
    body =
      error === undefined ? (
        <p className="text-muted-foreground text-sm">Loading triggers.</p>
      ) : (
        <p className="text-destructive text-sm">{error}</p>
      );
  } else {
    body = (
      <>
        {error !== undefined && (
          <p className="text-destructive text-sm">{error}</p>
        )}
        {triggers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No triggers for this agent yet.
          </p>
        ) : (
          <TriggerTable
            onApprove={approveTrigger}
            onReject={rejectTrigger}
            onRevoke={revokeTrigger}
            onToggle={toggleTrigger}
            showAgent={false}
            triggers={triggers}
          />
        )}
      </>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div>
        <Button onClick={openCreate}>Create trigger</Button>
      </div>
      {body}
      {creating ? (
        <CreateTriggerDialog
          agentId={agentId}
          onClose={closeCreate}
          onCreated={showSecret}
        />
      ) : null}
      {created === null ? null : (
        <TriggerSecretDialog
          onDone={closeSecret}
          secret={created.secret}
          title={secretTitle}
          triggerId={created.trigger.id}
        />
      )}
    </section>
  );
}
