import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Checkbox } from "#/components/ui/checkbox";
import { Label } from "#/components/ui/label";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentRecord } from "#/integrations/trpc/types";
import type { AgentPanelProps } from "./props.ts";

export function HandsToPanel({ agent }: AgentPanelProps) {
  const router = useRouter();
  const agentId = agent.id;
  const [agents, setAgents] = useState<AgentRecord[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getTrpc()
      .agents.list.query({})
      .then((items) => {
        if (active) {
          setAgents(items);
          setError(undefined);
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

  const toggle = useCallback(
    async (targetId: string, checked: boolean) => {
      const current = agent.handsTo;
      const next = checked
        ? [...current, targetId]
        : current.filter((id) => id !== targetId);
      setSaving(true);
      setError(undefined);
      try {
        await getTrpc().agents.update.mutate({
          id: agentId,
          patch: { handsTo: next },
        });
        await router.invalidate();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [agent.handsTo, agentId, router]
  );

  let body: ReactNode;
  if (agents === undefined) {
    body =
      error === undefined ? (
        <p className="text-muted-foreground text-sm">Loading agents.</p>
      ) : (
        <p className="text-destructive text-sm">{error}</p>
      );
  } else {
    const others = agents.filter(
      (other) => other.id !== agentId && other.status === "active"
    );
    body = (
      <>
        {error !== undefined && (
          <p className="text-destructive text-sm">{error}</p>
        )}
        {others.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No other active agents yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {others.map((other) => (
              <HandsToRow
                checked={agent.handsTo.includes(other.id)}
                disabled={saving}
                key={other.id}
                name={other.name}
                onToggle={toggle}
                targetId={other.id}
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Pick the agents this one can hand work to.
      </p>
      {body}
    </section>
  );
}

interface HandsToRowProps {
  checked: boolean;
  disabled: boolean;
  name: string;
  onToggle: (targetId: string, checked: boolean) => void;
  targetId: string;
}

function HandsToRow({
  checked,
  disabled,
  name,
  onToggle,
  targetId,
}: HandsToRowProps) {
  const inputId = `hands-to-${targetId}`;
  const change = useCallback(
    (next: boolean | "indeterminate") => onToggle(targetId, next === true),
    [onToggle, targetId]
  );
  return (
    <li className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={inputId}
        onCheckedChange={change}
      />
      <Label htmlFor={inputId}>{name}</Label>
    </li>
  );
}
