import { useAuth } from "@clerk/tanstack-react-start";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Switch } from "#/components/ui/switch.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentRecord } from "#/integrations/trpc/types";

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
        setError(cause instanceof Error ? cause.message : String(cause));
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
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
