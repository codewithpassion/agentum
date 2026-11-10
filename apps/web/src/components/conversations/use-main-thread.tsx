import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { useGo } from "#/components/rail/rail-link.tsx";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { threadHref } from "./conversation-logic.ts";

/** Opens the caller's main thread with an agent, making it on first use. */
export function useOpenMainThread() {
  const go = useGo();
  return useCallback(
    async (agentId: string) => {
      try {
        const thread = await getTrpc().sessions.main.mutate({ agentId });
        go(threadHref(thread.id));
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not open the conversation."
        );
      }
    },
    [go]
  );
}

export function MainThreadButton({
  agentId,
  children,
}: {
  agentId: string;
  children: ReactNode;
}) {
  const openMain = useOpenMainThread();
  const [pending, setPending] = useState(false);
  const handleClick = useCallback(async () => {
    setPending(true);
    try {
      await openMain(agentId);
    } finally {
      setPending(false);
    }
  }, [agentId, openMain]);
  return (
    <Button disabled={pending} onClick={handleClick} type="button">
      {children}
    </Button>
  );
}
