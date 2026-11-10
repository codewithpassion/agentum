import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Switch } from "#/components/ui/switch.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import { CHIP_CLASS, TONE_CLASS } from "./chip-list.tsx";

/** Chip for the agent's mailbox trigger, with a switch that pauses it. Re-mounts when `paused` changes. */
export function MailStartChip({
  address,
  agentId,
  paused,
}: {
  address: string;
  agentId: string;
  paused: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(!paused);
  const [saving, setSaving] = useState(false);

  const toggle = useCallback(
    async (next: boolean) => {
      const previous = on;
      setOn(next);
      setSaving(true);
      try {
        await getTrpc().setTrigger.mutate({ agentId, on: next });
        await router.invalidate();
      } catch (cause) {
        setOn(previous);
        toast.error(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [agentId, on, router]
  );

  return (
    <span className={`${CHIP_CLASS} ${TONE_CLASS.default}`}>
      Mail to {address}
      <Switch
        aria-label={`Mail to ${address} starts runs`}
        checked={on}
        disabled={saving}
        onCheckedChange={toggle}
        size="sm"
      />
    </span>
  );
}
