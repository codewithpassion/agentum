import { useCallback, useEffect, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { type Agent, type AgentStatusView, getAgentStatus } from "#/lib/api";
import { pollIntervalFor } from "#/lib/use-agent-screen";
import type { AgentStatusEvent } from "#/modules/messaging/realtime";
import { AgentActivityTab } from "./agent-activity-tab";
import { AgentFilesTab } from "./agent-files-tab";
import { AgentScreenTab } from "./agent-screen-tab";
import { ConnectorCard } from "./connector-card";
import { McpUrlField } from "./mcp-url";

/** The agent's screen (docs/plan.md 3c); Profile is the phase 1 rail, tabbed. */
const TABS = ["Screen", "Files", "Activity", "Profile"] as const;

type Tab = (typeof TABS)[number];

const STATUS_COLORS = {
  error: "var(--ws-danger)",
  idle: "var(--ws-muted)",
  queued: "var(--ws-accent)",
  working: "var(--ws-accent)",
} as const;

const STATUS_LABELS = {
  error: "error",
  idle: "idle",
  queued: "queued",
  working: "working…",
} as const;

const SYNC_LABELS = {
  error: "registration failed",
  synced: "registered with Anthropic",
  unregistered: "not registered yet",
} as const;

function StatusLine({
  sessionId,
  status,
}: {
  sessionId: string | null;
  status: Agent["status"];
}) {
  return (
    <p
      className="m-0 flex items-center gap-1.5 text-[var(--ws-muted)] text-xs"
      data-testid="agent-status"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${status === "working" ? "animate-pulse" : ""}`}
        style={{ background: STATUS_COLORS[status] }}
      />
      <span>{STATUS_LABELS[status]}</span>
      {sessionId ? (
        <span className="truncate font-mono text-[10px] opacity-70">
          {sessionId}
        </span>
      ) : null}
    </p>
  );
}

function SyncLine({
  syncError,
  syncStatus,
}: {
  syncError: string | null;
  syncStatus: Agent["syncStatus"];
}) {
  return (
    <p
      className={`m-0 text-xs ${syncStatus === "error" ? "text-[var(--ws-danger)]" : "text-[var(--ws-muted)]"}`}
      data-testid="agent-sync-status"
      title={syncError ?? undefined}
    >
      {SYNC_LABELS[syncStatus]}
      {syncStatus === "error" && syncError ? ` — ${syncError}` : ""}
    </p>
  );
}

/**
 * The row is refreshed on workspace reloads only, and the socket only reports
 * agents woken from the open channel - so the rail asks for the truth when an
 * agent is selected, and lets live events overtake it from there.
 */
const useAgentStatus = (
  agent: Agent | null,
  live: AgentStatusEvent | null
): AgentStatusView | null => {
  const [fetched, setFetched] = useState<AgentStatusView | null>(null);
  const agentId = agent?.id ?? null;

  useEffect(() => {
    if (!agentId) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    getAgentStatus(agentId)
      .then((status) => {
        if (!cancelled) {
          setFetched(status);
        }
      })
      .catch(() => {
        // The row we already have is a fine fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (!agent) {
    return null;
  }
  const base: AgentStatusView =
    fetched?.agentId === agent.id
      ? fetched
      : {
          agentId: agent.id,
          sessionId: agent.sessionId,
          status: agent.status,
          syncError: agent.syncError,
          syncStatus: agent.syncStatus,
        };

  return live ? { ...base, status: live.status } : base;
};

function Section({ body, title }: { body: string; title: string }) {
  return (
    <section className="space-y-1">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        {title}
      </h3>
      <p className="m-0 whitespace-pre-wrap text-[13px] text-[var(--ws-text)] leading-6">
        {body.length > 0 ? body : "—"}
      </p>
    </section>
  );
}

function AgentActions({
  agent,
  onDelete,
  onEdit,
}: {
  agent: Agent;
  onDelete: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
}) {
  const edit = useCallback(() => onEdit(agent), [agent, onEdit]);
  const remove = useCallback(() => onDelete(agent), [agent, onDelete]);

  return (
    <div className="flex gap-2">
      <Button onClick={edit} size="sm" variant="subtle">
        Edit
      </Button>
      <Button onClick={remove} size="sm" variant="danger">
        Delete
      </Button>
    </div>
  );
}

function TabButton({
  active,
  onSelect,
  tab,
}: {
  active: boolean;
  onSelect: (tab: Tab) => void;
  tab: Tab;
}) {
  const select = useCallback(() => onSelect(tab), [onSelect, tab]);

  return (
    <button
      aria-selected={active}
      className={`ws-focus w-full rounded-md px-2 py-1 text-xs ${active ? "bg-[var(--ws-panel)] text-[var(--ws-text)]" : "text-[var(--ws-muted)] hover:text-[var(--ws-text)]"}`}
      onClick={select}
      role="tab"
      type="button"
    >
      {tab}
    </button>
  );
}

function ProfilePanel({
  agent,
  mcpUrl,
  onDelete,
  onEdit,
}: {
  agent: Agent;
  mcpUrl: string | null;
  onDelete: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
}) {
  return (
    <div className="space-y-5">
      <McpUrlField url={mcpUrl} />
      <ConnectorCard agentId={agent.id} />
      <Section body={agent.soul} title="Soul" />
      <Section body={agent.instructions} title="Instructions" />
      <AgentActions agent={agent} onDelete={onDelete} onEdit={onEdit} />
    </div>
  );
}

export function AgentRail({
  agent,
  liveStatus,
  mcpUrl,
  onDelete,
  onEdit,
}: {
  agent: Agent | null;
  /** The router's latest word, when the open channel is the one that woke it. */
  liveStatus: AgentStatusEvent | null;
  /** Known only while this session still holds a freshly issued token. */
  mcpUrl: string | null;
  onDelete: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
}) {
  const status = useAgentStatus(agent, liveStatus);
  const [tab, setTab] = useState<Tab>("Screen");
  // A working agent is worth watching closely; an idle one is not worth the
  // requests (see lib/use-agent-screen).
  const pollMs = pollIntervalFor(status?.status === "working");

  return (
    <aside
      className="hidden w-80 shrink-0 flex-col overflow-y-auto border-[var(--ws-line)] border-l bg-[var(--ws-panel)] lg:flex"
      data-testid="agent-rail"
    >
      {agent && status ? (
        <div className="space-y-5 p-4">
          <div className="flex items-center gap-3">
            <Avatar color={agent.avatar} name={agent.name} size="lg" />
            <div className="min-w-0">
              <p className="m-0 truncate font-semibold text-sm">{agent.name}</p>
              <StatusLine sessionId={status.sessionId} status={status.status} />
              <SyncLine
                syncError={status.syncError}
                syncStatus={status.syncStatus}
              />
            </div>
          </div>

          <div
            aria-label="Agent screen"
            className="flex gap-1 rounded-lg bg-[var(--ws-surface)] p-1"
            role="tablist"
          >
            {TABS.map((name) => (
              <div className="flex-1" key={name}>
                <TabButton active={tab === name} onSelect={setTab} tab={name} />
              </div>
            ))}
          </div>

          <div role="tabpanel">
            {tab === "Screen" ? (
              <AgentScreenTab
                agentId={agent.id}
                key={agent.id}
                pollMs={pollMs}
              />
            ) : null}
            {tab === "Files" ? (
              <AgentFilesTab agentId={agent.id} key={agent.id} />
            ) : null}
            {tab === "Activity" ? (
              <AgentActivityTab
                agentId={agent.id}
                key={agent.id}
                pollMs={pollMs}
              />
            ) : null}
            {tab === "Profile" ? (
              <ProfilePanel
                agent={agent}
                mcpUrl={mcpUrl}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="m-0 font-medium text-sm">No agent selected</p>
          <p className="m-0 text-[var(--ws-muted)] text-xs">
            Click an agent in the sidebar or on a message to see its profile.
          </p>
        </div>
      )}
    </aside>
  );
}
