import { mailToolKey } from "@repo/db/shared";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

function MailAllowedRow({
  address,
  agentId,
  disabled,
}: {
  address: string;
  agentId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const remove = useCallback(async () => {
    setRemoving(true);
    setError(undefined);
    try {
      await getTrpc().requests.rules.remove.mutate({
        agentId,
        toolKey: mailToolKey(address),
      });
      await router.invalidate();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRemoving(false);
    }
  }, [address, agentId, router]);

  return (
    <li className="flex flex-col gap-1 py-1">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-xs">{address}</span>
        <Button
          aria-label={`Remove ${address}`}
          disabled={removing || disabled}
          onClick={remove}
          size="sm"
          variant="ghost"
        >
          Remove
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** Addresses the agent may always email without asking. */
export function MailAllowedList({
  addresses,
  agentId,
  disabled,
}: {
  addresses: string[];
  agentId: string;
  disabled: boolean;
}) {
  return (
    <div className="mt-3">
      <h3 className="text-muted-foreground text-xs">Always allowed</h3>
      <ul>
        {addresses.map((address) => (
          <MailAllowedRow
            address={address}
            agentId={agentId}
            disabled={disabled}
            key={address}
          />
        ))}
      </ul>
    </div>
  );
}
