import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Switch } from "#/components/ui/switch.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { AgentRecord } from "#/integrations/trpc/types";
import { browserConfig, browserOn } from "./profile-logic.ts";

/** The on/off switch for the built-in browser, shown on the Tools row. */
export function BrowserSwitch({
  agent,
  onChanged,
}: {
  agent: AgentRecord;
  onChanged?: () => void;
}) {
  const router = useRouter();
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
            runtimeConfig: browserConfig(agent.runtimeConfig, checked),
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
    [agent.id, agent.runtimeConfig, onChanged, router]
  );

  return (
    <div className="flex flex-col gap-1">
      <Switch
        aria-label="Browser"
        checked={browserOn(agent.runtimeConfig)}
        disabled={saving}
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
