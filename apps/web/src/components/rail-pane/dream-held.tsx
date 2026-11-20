import type { DreamDecision, DreamHeldNeedsYou } from "@repo/db/shared";
import { useCallback, useState } from "react";
import { HeldBatch } from "#/components/agent/room/knows/dream/held-batch.tsx";
import { errorMessage } from "#/lib/error-message";

/**
 * A dream the learn level held, for the person who may decide it. The server
 * sends this card only to them, so Approve and Reject are always drawn.
 */
export function DreamHeldBody({
  dreamHeld,
  onDecide,
}: {
  dreamHeld: DreamHeldNeedsYou;
  onDecide: (dreamRunId: string, decision: DreamDecision) => Promise<void>;
}) {
  const [pending, setPending] = useState<DreamDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = useCallback(
    async (dreamRunId: string, decision: DreamDecision) => {
      setPending(decision);
      setError(null);
      try {
        await onDecide(dreamRunId, decision);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setPending(null);
      }
    },
    [onDecide]
  );

  return (
    <div className="flex flex-col gap-3" data-testid="dream-held-body">
      <HeldBatch
        canDecide
        disabled={false}
        dreamRunId={dreamHeld.dreamRunId}
        onDecide={decide}
        pending={pending}
      />
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
