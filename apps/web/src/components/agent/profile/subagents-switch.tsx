import { useAuth } from "@clerk/tanstack-react-start";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Switch } from "#/components/ui/switch.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentRecord } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

/** Only the owner or an organisation admin may enable subagents. */
export function SubagentsSwitch({
  agent,
  onChanged,
}: {
  agent: AgentRecord;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const { userId, orgRole } = useAuth();
  const canEdit =
    orgRole === "org:admin" ||
    userId === (agent.ownerUserId ?? agent.createdBy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const change = useCallback(
    async (checked: boolean) => {
      setSaving(true);
      setError(undefined);
      try {
        await getTrpc().agents.update.mutate({
          id: agent.id,
          patch: {
            subagents: checked,
          },
        });
        await router.invalidate();
        onChanged?.();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [agent.id, onChanged, router]
  );

  return (
    <div className="flex flex-col gap-1">
      <Switch
        aria-label="Subagents"
        checked={agent.subagents}
        disabled={saving || !canEdit}
        onCheckedChange={change}
        size="sm"
      />
      <p className="text-muted-foreground text-xs">
        Helpers can narrow connectors and secrets. Their built-in tools (shell,
        files) are not limited. Agents with a computer cannot start subagents
        yet, because they share one computer. Machines need an updated agentum
        client.
      </p>
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
