import type { RailCard } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import { errorMessage } from "#/lib/error-message";

/** A run that failed or a mail that bounced: what happened, the log, and Dismiss. */
export function ProblemBody({
  card,
  onDismiss,
}: {
  card: RailCard;
  onDismiss: (runId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { runId, threadId } = card;
  const dismiss = useCallback(async () => {
    if (runId === null) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onDismiss(runId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }, [onDismiss, runId]);

  return (
    <div className="flex flex-col gap-3" data-testid="problem-body">
      <p className="text-destructive">{card.detail}</p>
      <div className="flex flex-wrap gap-2">
        {runId === null ? null : (
          <Link
            className={buttonVariants({ variant: "link" })}
            params={{ runId }}
            to="/tasks/$runId"
          >
            Open the log
          </Link>
        )}
        {runId === null && threadId !== null ? (
          <Link
            className={buttonVariants({ variant: "link" })}
            search={{ thread: threadId }}
            to="/inbox"
          >
            Open the thread
          </Link>
        ) : null}
        {runId === null ? null : (
          <Button
            disabled={pending}
            onClick={dismiss}
            type="button"
            variant="outline"
          >
            Dismiss
          </Button>
        )}
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
