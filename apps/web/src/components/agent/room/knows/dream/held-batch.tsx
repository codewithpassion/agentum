import type { DreamDecision } from "@repo/db/shared";
import type { ReactElement } from "react";
import { useCallback } from "react";
import { Button } from "#/components/ui/button.tsx";
import { OpenChanges } from "./see-changes.tsx";

/**
 * A dream the agent's learn level held: the changes it proposes, and Approve
 * and Reject for the owner or an admin. Anyone else reads the changes only.
 */
export function HeldBatch({
  canDecide,
  disabled,
  dreamRunId,
  onDecide,
  pending,
}: {
  canDecide: boolean;
  /** Nothing acts: an archived agent, or another action is under way. */
  disabled: boolean;
  dreamRunId: string;
  onDecide: (dreamRunId: string, decision: DreamDecision) => void;
  /** The decision being sent, or null. */
  pending: DreamDecision | null;
}): ReactElement {
  const approve = useCallback(
    () => onDecide(dreamRunId, "approve"),
    [dreamRunId, onDecide]
  );
  const reject = useCallback(
    () => onDecide(dreamRunId, "reject"),
    [dreamRunId, onDecide]
  );
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="held-batch">
      <p className="text-sm">
        {canDecide
          ? "These changes are held. Nothing changes in memory until you approve."
          : "These changes wait for the agent's owner or an admin to approve."}
      </p>
      <OpenChanges runId={dreamRunId} />
      {canDecide ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled || pending !== null}
            onClick={approve}
            size="sm"
            type="button"
          >
            {pending === "approve" ? "Approving…" : "Approve"}
          </Button>
          <Button
            disabled={disabled || pending !== null}
            onClick={reject}
            size="sm"
            type="button"
            variant="outline"
          >
            {pending === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
