import { useEffect, useState } from "react";
import { useSessionNotice } from "#/lib/agent-session-notice";
import type { MessageView } from "#/lib/api";
import { formatRelativeTime } from "#/lib/format";
import { NEW_SESSION_BADGE_MS, newSessionBadge } from "#/lib/session-divider";
import { useActiveWorkspace } from "#/lib/workspace-context";

/** A subtle badge in a DM header for the first minutes after a reset. */
export function NewSessionBadge({ messages }: { messages: MessageView[] }) {
  const [now, setNow] = useState(() => Date.now());
  const startedAt = newSessionBadge(messages, now);

  useEffect(() => {
    setNow(Date.now());
    if (startedAt === null) {
      return;
    }
    const remaining = startedAt + NEW_SESSION_BADGE_MS - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => clearTimeout(timer);
  }, [startedAt]);

  if (startedAt === null) {
    return null;
  }
  return (
    <span className="rounded-full border border-[var(--ws-line)] px-2 py-0.5 text-[10px] text-[var(--ws-muted)]">
      New session
    </span>
  );
}

/**
 * When the agent's current session began, in the agent rail. Owner-only, like
 * the session history it reads. After a reset there is no current session
 * until the agent's next message creates one.
 */
export function AgentSessionStatus({ agentId }: { agentId: string }) {
  const { api, membership } = useActiveWorkspace();
  const isOwner = membership?.role === "owner";
  // A reset raises a notice; reading it re-runs the lookup below.
  const notice = useSessionNotice(agentId);
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) {
      return;
    }
    let live = notice !== undefined;
    api
      .listAgentSessions(agentId)
      .then((sessions) => {
        const current = sessions.find((session) => session.current);
        if (live) {
          setLabel(
            current
              ? `Session started ${formatRelativeTime(Date.parse(current.startedAt))}`
              : "New session starts with the next message"
          );
        }
      })
      .catch(() => live && setLabel(null));
    return () => {
      live = false;
    };
  }, [agentId, api, isOwner, notice]);

  if (!(isOwner && label)) {
    return null;
  }
  return <p className="m-0 text-[var(--ws-muted)] text-xs">{label}</p>;
}
