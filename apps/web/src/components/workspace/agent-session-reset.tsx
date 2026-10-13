import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { sessionResetMessage } from "#/lib/agent-session";
import { useActiveWorkspace } from "#/lib/workspace-context";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * Owner-only: retires the agent's current session, so its next message starts
 * a fresh one. Members see nothing, as the API refuses them anyway.
 */
export function NewSessionControl({ agentId }: { agentId: string }) {
  const { api, membership } = useActiveWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const openConfirm = useCallback(() => setConfirming(true), []);
  const cancelConfirm = useCallback(() => setConfirming(false), []);

  // A failure throws out of here, and the dialog shows it.
  const startNewSession = useCallback(async () => {
    const result = await api.resetAgentSession(agentId);
    setNotice(sessionResetMessage(result.retired));
    setConfirming(false);
  }, [agentId, api]);

  if (membership?.role !== "owner") {
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button onClick={openConfirm} size="sm" variant="subtle">
        New session
      </Button>
      {notice ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs" role="status">
          {notice}
        </p>
      ) : null}
      {/* Mounted only while open, so an error from one attempt does not
          greet the next. */}
      {confirming ? (
        <ConfirmDialog
          confirmLabel="Confirm"
          confirmVariant="primary"
          message="Start a new session? The agent forgets this conversation's working context."
          onCancel={cancelConfirm}
          onConfirm={startNewSession}
          open
          title="New session"
        />
      ) : null}
    </div>
  );
}
