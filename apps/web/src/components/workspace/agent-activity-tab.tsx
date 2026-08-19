import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { mergeActivity } from "#/lib/agent-screen";
import { type ActivityView, listAgentActivity } from "#/lib/api";
import { formatRelativeTime } from "#/lib/format";
import { usePolling } from "#/lib/use-agent-screen";

/**
 * The right rail's Activity tab: everything the agent has done, newest first,
 * from the one activity log the computer, the browser and the wiki all write
 * to. The newest page is polled; older ones are pulled in by "Load more".
 */

const PAGE_SIZE = 50;

const ICONS: Record<ActivityView["kind"], string> = {
  "browser.click": "👆",
  "browser.fill": "⌨️",
  "browser.navigate": "🌐",
  "browser.screenshot": "📸",
  "computer.delete": "🗑️",
  "computer.edit": "✏️",
  "computer.exec": "⌗",
  "computer.write": "📄",
  "wiki.edit": "📓",
};

function ActivityRow({ entry }: { entry: ActivityView }) {
  return (
    <li className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--ws-surface-hover)]">
      <span aria-hidden="true" className="text-xs leading-5">
        {ICONS[entry.kind] ?? "•"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[13px] leading-5">
          {entry.summary}
        </span>
        <span className="block text-[10px] text-[var(--ws-muted)]">
          {entry.kind} · {formatRelativeTime(entry.createdAt)}
        </span>
      </span>
    </li>
  );
}

export function AgentActivityTab({
  agentId,
  pollMs,
}: {
  agentId: string;
  pollMs: number;
}) {
  const [entries, setEntries] = useState<ActivityView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // The first page sets the cursor once; from then on "Load more" owns it, so
  // a poll cannot rewind the feed to a page that is already on screen.
  const [paginated, setPaginated] = useState(false);

  const refresh = useCallback(() => {
    listAgentActivity(agentId, { limit: PAGE_SIZE })
      .then((page) => {
        setEntries((previous) => mergeActivity(previous, page.entries));
        if (!paginated) {
          setCursor(page.nextCursor);
        }
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read the activity."
        );
      })
      .finally(() => setLoaded(true));
  }, [agentId, paginated]);

  usePolling(refresh, pollMs);

  const loadMore = useCallback(() => {
    if (!cursor) {
      return;
    }
    setBusy(true);
    setPaginated(true);
    listAgentActivity(agentId, { before: cursor, limit: PAGE_SIZE })
      .then((page) => {
        setEntries((previous) => mergeActivity(previous, page.entries));
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not read the activity."
        );
      })
      .finally(() => setBusy(false));
  }, [agentId, cursor]);

  return (
    <div className="space-y-2" data-testid="agent-activity-feed">
      {error ? (
        <div className="space-y-2 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] p-3 text-center">
          <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
            {error}
          </p>
          <Button onClick={refresh} size="sm" variant="subtle">
            Retry
          </Button>
        </div>
      ) : null}

      {loaded && entries.length === 0 && !error ? (
        <p
          className="m-0 text-[var(--ws-muted)] text-xs leading-5"
          data-testid="agent-activity-empty"
        >
          Nothing yet. Commands, file changes and pages the agent visits show up
          here.
        </p>
      ) : null}

      {entries.length > 0 ? (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {entries.map((entry) => (
            <ActivityRow entry={entry} key={entry.id} />
          ))}
        </ul>
      ) : null}

      {cursor ? (
        <Button
          className="w-full justify-center"
          disabled={busy}
          onClick={loadMore}
          size="sm"
          variant="subtle"
        >
          {busy ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
