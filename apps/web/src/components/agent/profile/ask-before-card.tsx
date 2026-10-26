import { useCallback, useState } from "react";
import { Switch } from "#/components/ui/switch.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { MailAllowedList } from "./mail-allowed-list.tsx";

type AskBeforeAction = RouterOutputs["agentProfile"]["askBefore"][number];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function AskBeforeRow({
  agentId,
  item,
}: {
  agentId: string;
  item: AskBeforeAction;
}) {
  const [ask, setAsk] = useState(item.ask);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const toggle = useCallback(
    async (next: boolean) => {
      const previous = ask;
      setAsk(next);
      setSaving(true);
      setError(undefined);
      try {
        await getTrpc().agentProfile.setAskBefore.mutate({
          action: item.action,
          agentId,
          ask: next,
        });
      } catch (cause) {
        setAsk(previous);
        setError(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [agentId, ask, item.action]
  );

  return (
    <li className="flex flex-col gap-1 border-border border-t border-dashed py-2.5 first:border-t-0">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-sm">{item.label}</span>
        <Switch
          aria-label={`Ask before ${item.label}`}
          checked={ask}
          disabled={saving}
          onCheckedChange={toggle}
        />
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Lists the actions the agent must ask about first. Re-mounts per agent. */
function AskBeforeList({
  actions,
  agentId,
}: {
  actions: RouterOutputs["agentProfile"]["askBefore"];
  agentId: string;
}) {
  if (actions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No actions to ask about yet.
      </p>
    );
  }
  return (
    <ul>
      {actions.map((item) => (
        <AskBeforeRow agentId={agentId} item={item} key={item.action} />
      ))}
    </ul>
  );
}

export function AskBeforeCard({
  actions,
  agentId,
  mailAllowed,
}: {
  agentId: string;
  actions: RouterOutputs["agentProfile"]["askBefore"];
  /** Bare email addresses the agent may always email without asking. */
  mailAllowed: string[];
}) {
  return (
    <section
      aria-label="Ask me before it"
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <h2 className="font-semibold text-sm">Ask me before it…</h2>
      <p className="mb-2 text-muted-foreground text-xs">
        The agent stops and asks you before it does these. Everything else runs
        without asking.
      </p>
      <AskBeforeList actions={actions} agentId={agentId} key={agentId} />
      <div className="flex items-center justify-between gap-3 border-border border-t border-dashed py-2.5">
        <span className="min-w-0 text-sm">
          Emails someone outside the workspace: always asks
        </span>
        <span className="text-muted-foreground text-xs">Always</span>
      </div>
      {mailAllowed.length === 0 ? null : (
        <MailAllowedList addresses={mailAllowed} agentId={agentId} />
      )}
    </section>
  );
}
