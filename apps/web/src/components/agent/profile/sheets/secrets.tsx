import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "#/components/ui/empty";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentPanelProps } from "./props.ts";
import { toggledIds } from "./secrets/grants.ts";
import { RuntimeNotes } from "./secrets/runtime-notes.tsx";
import { type SecretRecord, SecretRow } from "./secrets/secret-row.tsx";
import { secretStatus } from "./secrets/status.ts";

interface SecretsState {
  grantedIds: string[];
  secrets: SecretRecord[];
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

export function SecretsPanel({ agent }: AgentPanelProps) {
  const agentId = agent.id;
  const [state, setState] = useState<SecretsState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      getTrpc().secrets.list.query(),
      getTrpc().secrets.grants.query({ agentId }),
    ])
      .then(([secrets, grantedIds]) => {
        if (active) {
          setState({ grantedIds, secrets });
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
  }, [agentId]);

  const toggle = useCallback(
    async (secretId: string, granted: boolean) => {
      if (state === undefined) {
        return;
      }
      setSaving(true);
      try {
        const grantedIds = await getTrpc().secrets.setGrants.mutate({
          agentId,
          secretIds: toggledIds(state.grantedIds, secretId, granted),
        });
        setState({ grantedIds, secrets: state.secrets });
        setError(undefined);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [agentId, state]
  );

  if (state === undefined) {
    return error === undefined ? (
      <p className="text-muted-foreground text-sm">Loading secrets.</p>
    ) : (
      <p className="text-destructive text-sm">{error}</p>
    );
  }

  const grantedSet = new Set(state.grantedIds);

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm">
        A granted secret is delivered on every run of this agent. A proxy secret
        is added as a header to requests to its hosts, so the agent&apos;s code
        never sees it. An env secret is set as an environment variable for
        machine and Linux VM agents. An isolate agent gets a placeholder
        instead, which is filled in only for the secret&apos;s allowed hosts.
        Secrets are managed under{" "}
        <Link to="/settings/secrets">Settings, Secrets</Link>.
      </p>
      {error !== undefined && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {state.secrets.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No secrets yet</EmptyTitle>
            <EmptyDescription>
              Add a secret under Settings, Secrets, then grant it to this agent.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild variant="outline">
              <Link to="/settings/secrets">Open Secrets</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Granted</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Hosts</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.secrets.map((secret) => (
                <SecretRow
                  disabled={saving}
                  granted={grantedSet.has(secret.id)}
                  key={secret.id}
                  onToggle={toggle}
                  secret={secret}
                  status={
                    grantedSet.has(secret.id)
                      ? secretStatus(secret, agent)
                      : null
                  }
                />
              ))}
            </TableBody>
          </Table>
          <RuntimeNotes />
        </>
      )}
    </section>
  );
}
