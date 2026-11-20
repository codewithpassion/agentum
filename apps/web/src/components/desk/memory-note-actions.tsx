import type { DeskCard } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

type Decision = "approve" | "reject";

/** The note the agent wants to keep, with Approve and Reject. The card's id is the held change's id. */
export function MemoryNoteActions({
  card,
  onChanged,
}: {
  card: DeskCard;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: Decision) => {
      setPending(true);
      setError(null);
      try {
        await getTrpc().memory.decide.mutate({ changeId: card.id, decision });
        onChanged();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(false);
      }
    },
    [card.id, onChanged]
  );

  const approve = useCallback(() => decide("approve"), [decide]);
  const reject = useCallback(() => decide("reject"), [decide]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <p className="font-semibold">{card.title}</p>
        <p className="text-muted-foreground text-xs">
          Held until you approve it. Approving adds it to what the agent knows.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 pointer-coarse:gap-3">
        <Button disabled={pending} onClick={approve} size="sm" type="button">
          Approve
        </Button>
        <Button
          disabled={pending}
          onClick={reject}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
