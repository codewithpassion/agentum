import { useUser } from "@clerk/tanstack-react-start";
import { useCallback, useMemo, useState } from "react";
import type { Agent, Channel, MessageView } from "#/lib/api";
import type { Viewer } from "#/lib/authors";
import { type AgentStatuses, useConversation } from "#/lib/use-conversation";
import { useWorkspaceData } from "#/lib/use-workspace-data";
import { useActiveWorkspace } from "#/lib/workspace-context";
import type { AgentStatusEvent } from "#/modules/messaging/realtime";
import { AgentDialog } from "./agent-dialog";
import { AgentRail } from "./agent-rail";
import { ChannelDialog } from "./channel-dialog";
import { ConfirmDialog } from "./confirm-dialog";
import { ConversationPane } from "./conversation";
import { Sidebar } from "./sidebar";
import { ThreadPanel } from "./thread-panel";

export interface WorkspaceSelection {
  agent?: string;
  channel?: string;
}

/** A thread belongs to one channel, so leaving the channel closes it. */
interface OpenThread {
  channelId: string;
  messageId: string;
}

/** The router only reports on agents woken from the channel that is open. */
const liveStatusFor = (
  statuses: AgentStatuses,
  agent: Agent | null
): AgentStatusEvent | null => (agent ? (statuses[agent.id] ?? null) : null);

function SignedOutLanding() {
  return (
    <div className="ws-shell items-center justify-center">
      <div className="max-w-sm space-y-3 px-6 text-center">
        <h1 className="m-0 font-semibold text-xl">Agentum</h1>
        <p className="m-0 text-[var(--ws-muted)] text-sm">
          A workspace where you and your agents talk in channels, threads and
          DMs.
        </p>
        <a
          className="inline-block rounded-lg bg-[var(--ws-accent)] px-4 py-2 font-medium text-[var(--ws-accent-ink)] text-sm no-underline"
          href="/login"
        >
          Sign in
        </a>
      </div>
    </div>
  );
}

export function Workspace({
  onSelect,
  selection,
}: {
  onSelect: (next: WorkspaceSelection) => void;
  selection: WorkspaceSelection;
}) {
  const { api, membership } = useActiveWorkspace();

  const { isSignedIn, user } = useUser();
  const signedIn = isSignedIn === true;
  const { agents, categories, channels, error, reload } =
    useWorkspaceData(signedIn);

  // Every `/api` route is behind auth, so nothing may be fetched - and no
  // socket opened - until Clerk confirms a session.
  const channelId = signedIn ? (selection.channel ?? null) : null;
  const agentId = selection.agent ?? null;
  const conversation = useConversation(channelId);

  const [thread, setThread] = useState<OpenThread | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  // Bumped when the settings dialog closes, so the rail's connector chips pick
  // up an assignment made in it. The picker writes through immediately, so
  // closing the dialog is the moment the rail can be stale.
  const [connectorRevision, setConnectorRevision] = useState(0);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  // MCP tokens are stored hashed, so a freshly issued URL only exists here,
  // for as long as this page stays loaded.
  const [mcpUrls, setMcpUrls] = useState<Record<string, string>>({});

  const threadParentId =
    thread && thread.channelId === channelId ? thread.messageId : null;

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents]
  );
  const selectedAgent = agentId ? (agentsById.get(agentId) ?? null) : null;

  // Name and picture come from Clerk's session; who "me" is in a message comes
  // from the workspace membership, never from the Clerk id.
  const viewer: Viewer = {
    imageUrl: user?.imageUrl ?? null,
    memberId: membership ? membership.memberId : null,
    name: user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "You",
  };

  const selectAgent = useCallback(
    (id: string) => {
      setRailOpen(true);
      onSelect({ ...selection, agent: id });
    },
    [onSelect, selection]
  );

  const openChannel = useCallback(
    (id: string) => onSelect({ ...selection, channel: id }),
    [onSelect, selection]
  );

  const openDm = useCallback(
    (agent: Agent) => {
      (async () => {
        const channel = await api.openAgentDm(agent.id);
        await reload();
        onSelect({ agent: agent.id, channel: channel.id });
      })();
    },
    [api, onSelect, reload]
  );

  const openThread = useCallback((message: MessageView) => {
    setThread({ channelId: message.channelId, messageId: message.id });
  }, []);

  const closeThread = useCallback(() => setThread(null), []);
  const toggleRail = useCallback(() => setRailOpen((open) => !open), []);

  const startNewAgent = useCallback(() => {
    setEditingAgent(null);
    setAgentDialogOpen(true);
  }, []);
  const startEditAgent = useCallback((agent: Agent) => {
    setEditingAgent(agent);
    setAgentDialogOpen(true);
  }, []);
  const closeAgentDialog = useCallback(() => {
    setAgentDialogOpen(false);
    setConnectorRevision((revision) => revision + 1);
  }, []);
  const openChannelDialog = useCallback(() => setChannelDialogOpen(true), []);
  const closeChannelDialog = useCallback(() => setChannelDialogOpen(false), []);
  const cancelDelete = useCallback(() => setDeletingAgent(null), []);

  const onAgentSaved = useCallback(
    async (agent: Agent) => {
      await reload();
      selectAgent(agent.id);
    },
    [reload, selectAgent]
  );

  const onTokenIssued = useCallback((issuedFor: string, issuedUrl: string) => {
    setMcpUrls((previous) => ({ ...previous, [issuedFor]: issuedUrl }));
  }, []);

  const onChannelCreated = useCallback(
    async (channel: Channel) => {
      await reload();
      onSelect({ ...selection, channel: channel.id });
    },
    [onSelect, reload, selection]
  );

  const confirmDelete = useCallback(async () => {
    if (!deletingAgent) {
      return;
    }
    await api.deleteAgent(deletingAgent.id);
    setDeletingAgent(null);
    onSelect({ channel: selection.channel });
    await reload();
  }, [api, deletingAgent, onSelect, reload, selection.channel]);

  if (isSignedIn === false) {
    return <SignedOutLanding />;
  }

  return (
    <div className="ws-shell">
      <Sidebar
        activeAgentId={agentId}
        activeChannelId={channelId}
        agents={agents}
        categories={categories}
        channels={channels}
        onNewAgent={startNewAgent}
        onNewChannel={openChannelDialog}
        onOpenChannel={openChannel}
        onOpenDm={openDm}
        onReload={reload}
        onSelectAgent={selectAgent}
        viewerName={viewer.name}
      />

      <ConversationPane
        agents={agents}
        agentsById={agentsById}
        conversation={conversation}
        onOpenThread={openThread}
        onSelectAgent={selectAgent}
        onToggleRail={toggleRail}
        viewer={viewer}
      />

      {threadParentId ? (
        <ThreadPanel
          agents={agents}
          agentsById={agentsById}
          conversation={conversation}
          onClose={closeThread}
          onSelectAgent={selectAgent}
          parentId={threadParentId}
          viewer={viewer}
        />
      ) : null}

      {railOpen ? (
        <AgentRail
          agent={selectedAgent}
          connectorRevision={connectorRevision}
          liveStatus={liveStatusFor(conversation.agentStatuses, selectedAgent)}
          mcpUrl={selectedAgent ? (mcpUrls[selectedAgent.id] ?? null) : null}
          onDelete={setDeletingAgent}
          onEdit={startEditAgent}
        />
      ) : null}

      {error ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-danger)] text-xs">
          {error}
        </p>
      ) : null}

      <AgentDialog
        agent={editingAgent}
        mcpUrl={editingAgent ? (mcpUrls[editingAgent.id] ?? null) : null}
        onClose={closeAgentDialog}
        onSaved={onAgentSaved}
        onTokenIssued={onTokenIssued}
        open={agentDialogOpen}
      />

      <ChannelDialog
        agents={agents}
        onClose={closeChannelDialog}
        onCreated={onChannelCreated}
        open={channelDialogOpen}
      />

      <ConfirmDialog
        confirmLabel="Delete agent"
        message={`Delete ${deletingAgent?.name ?? ""}? Its messages stay, but the agent is gone.`}
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
        open={deletingAgent !== null}
        title="Delete agent"
      />
    </div>
  );
}
