import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

/** Asks the mail service to provision the agent's mailbox, then reloads the page data. */
export function MailProvisionButton({
  agentId,
  label,
}: {
  agentId: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const provision = useCallback(async () => {
    setPending(true);
    try {
      await getTrpc().mailbox.provision.mutate({ agentId });
      await router.invalidate();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }, [agentId, router]);

  return (
    <Button disabled={pending} onClick={provision} size="sm" variant="outline">
      {label}
    </Button>
  );
}
