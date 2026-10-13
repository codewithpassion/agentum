import { useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { sessionEndLabel, sessionResetMessage } from "#/lib/agent-session";
import type { AgentSessionView } from "#/lib/api";
import { formatDay, formatTime } from "#/lib/format";
import { useActiveWorkspace } from "#/lib/workspace-context";
import { ConfirmDialog } from "./confirm-dialog";

const stamp = (iso: string): string => {
  const at = Date.parse(iso);
  return `${formatDay(at)} ${formatTime(at)}`;
};

function PastSessionRow({
  onResume,
  session,
}: {
  onResume: (session: AgentSessionView) => void;
  session: AgentSessionView;
}) {
  const resume = useCallback(() => onResume(session), [onResume, session]);
  return (
    <li className="flex items-center justify-between gap-2 text-[var(--ws-muted)] text-xs">
      <span>
        {stamp(session.startedAt)}
        {session.endedAt ? ` to ${stamp(session.endedAt)}` : ""}
        {session.endReason ? `, ${sessionEndLabel(session.endReason)}` : ""}
      </span>
      <Button onClick={resume} size="sm" variant="subtle">
        Resume
      </Button>
    </li>
  );
}

/** Said plainly, in a box, so that a finished reset cannot be mistaken for nothing happening. */
export function ResetNotice({ message }: { message: string }) {
  return (
    <p
      className="m-0 w-full rounded-lg border border-[var(--ws-accent)] bg-[color-mix(in_oklab,var(--ws-accent)_14%,transparent)] px-2.5 py-1.5 text-[var(--ws-text)] text-xs"
      role="status"
    >
      {message}
    </p>
  );
}

/**
 * Owner-only: retires the agent's current session, so its next message starts
 * a fresh one, and lists the earlier ones with a way back into each. Members
 * see nothing, as the API refuses them anyway.
 */
export function NewSessionControl({ agentId }: { agentId: string }) {
  const { api, membership } = useActiveWorkspace();
  const isOwner = membership?.role === "owner";
  const [confirming, setConfirming] = useState(false);
  const [resuming, setResuming] = useState<AgentSessionView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionView[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!isOwner) {
      return;
    }
    // `version` re-runs this after a reset or a resume changed the list.
    let live = version >= 0;
    api
      .listAgentSessions(agentId)
      .then((list) => live && setSessions(list))
      .catch(() => live && setSessions([]));
    return () => {
      live = false;
    };
  }, [agentId, api, isOwner, version]);

  const openConfirm = useCallback(() => setConfirming(true), []);
  const cancelConfirm = useCallback(() => setConfirming(false), []);
  const cancelResume = useCallback(() => setResuming(null), []);

  // A failure throws out of here, and the dialog shows it.
  const startNewSession = useCallback(async () => {
    const result = await api.resetAgentSession(agentId);
    setNotice(sessionResetMessage(result.retired));
    setConfirming(false);
    setVersion((current) => current + 1);
  }, [agentId, api]);

  const resume = useCallback(async () => {
    if (!resuming) {
      return;
    }
    await api.resumeAgentSession(agentId, resuming.id);
    setNotice("Resumed. The agent continues in that session.");
    setResuming(null);
    setVersion((current) => current + 1);
  }, [agentId, api, resuming]);

  if (!isOwner) {
    return null;
  }

  const past = sessions.filter((session) => !session.current);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button onClick={openConfirm} size="sm" variant="subtle">
        New session
      </Button>
      {notice ? <ResetNotice message={notice} /> : null}
      {past.length > 0 ? (
        <div className="mt-2 flex w-full flex-col gap-1">
          <p className="m-0 font-medium text-xs">Past sessions</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {past.map((session) => (
              <PastSessionRow
                key={session.id}
                onResume={setResuming}
                session={session}
              />
            ))}
          </ul>
        </div>
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
      {resuming ? (
        <ConfirmDialog
          confirmLabel="Resume"
          confirmVariant="primary"
          message="Resume this session? The current one is set aside. A resumed session keeps the tool setup it started with, so tools added since then are missing until you start a new session."
          onCancel={cancelResume}
          onConfirm={resume}
          open
          title="Resume session"
        />
      ) : null}
    </div>
  );
}
