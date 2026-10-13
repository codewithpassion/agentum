import { useCallback } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import type { Agent, ChannelMemberView, MessageView } from "#/lib/api";
import type { Viewer } from "#/lib/authors";
import type { ClearCommand } from "#/lib/session-divider";
import type { Conversation as ConversationState } from "#/lib/use-conversation";
import { useActiveWorkspace, useApi } from "#/lib/workspace-context";
import { AgentActivity } from "./agent-activity";
import { ChannelSettings } from "./channel-settings";
import { Composer } from "./composer";
import { MessageStream } from "./message-stream";
import { NewSessionBadge } from "./session-indicators";

const FALLBACK_COLOR = "#52525b";

function MemberAvatar({
  color,
  member,
  onSelectAgent,
}: {
  color: string;
  member: ChannelMemberView;
  onSelectAgent: (agentId: string) => void;
}) {
  const select = useCallback(
    () => onSelectAgent(member.memberId),
    [member.memberId, onSelectAgent]
  );
  const name = member.name ?? "Agent";

  return (
    <button
      className="ws-focus rounded-full"
      onClick={select}
      title={`Open ${name}'s profile`}
      type="button"
    >
      <Avatar color={color} name={name} size="sm" />
    </button>
  );
}

function ChannelHeader({
  agents,
  agentsById,
  conversation,
  onChannelDeleted,
  onSelectAgent,
  onToggleRail,
}: {
  agents: Agent[];
  agentsById: Map<string, Agent>;
  conversation: ConversationState;
  onChannelDeleted: () => void;
  onSelectAgent: (agentId: string) => void;
  onToggleRail: () => void;
}) {
  const { channel, members } = conversation;
  const agentMembers = members.filter(
    (member) => member.memberType === "agent"
  );

  return (
    <header className="flex items-center gap-3 border-[var(--ws-line)] border-b px-4 py-3">
      <h1 className="m-0 truncate font-semibold text-[15px]">
        {channel?.kind === "dm" ? channel.name : `# ${channel?.name ?? ""}`}
      </h1>
      <ul className="m-0 flex list-none items-center gap-1 p-0">
        {agentMembers.map((member) => (
          <li key={member.memberId}>
            <MemberAvatar
              color={agentsById.get(member.memberId)?.avatar ?? FALLBACK_COLOR}
              member={member}
              onSelectAgent={onSelectAgent}
            />
          </li>
        ))}
      </ul>
      {channel?.kind === "dm" ? (
        <NewSessionBadge messages={conversation.messages} />
      ) : null}
      <span className="text-[var(--ws-muted)] text-xs">
        {members.length} {members.length === 1 ? "member" : "members"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {channel ? (
          <ChannelSettings
            agents={agents}
            channel={channel}
            members={members}
            onDeleted={onChannelDeleted}
            onMembersChange={conversation.setMembers}
          />
        ) : null}
        <Button onClick={onToggleRail} size="sm" variant="ghost">
          Agent screen
        </Button>
      </div>
    </header>
  );
}

export function ConversationPane({
  agents,
  agentsById,
  conversation,
  onChannelDeleted,
  onOpenThread,
  onSelectAgent,
  onToggleRail,
  viewer,
}: {
  agents: Agent[];
  agentsById: Map<string, Agent>;
  conversation: ConversationState;
  onChannelDeleted: () => void;
  onOpenThread: (message: MessageView) => void;
  onSelectAgent: (agentId: string) => void;
  onToggleRail: () => void;
  viewer: Viewer;
}) {
  const api = useApi();
  const { membership } = useActiveWorkspace();
  const isOwner = membership?.role === "owner";

  const { channel, mergeMessage } = conversation;
  const channelId = channel?.id ?? null;

  const send = useCallback(
    async (input: { attachmentIds: string[]; body: string }) => {
      if (!channelId) {
        return;
      }
      mergeMessage(await api.postMessage(channelId, input));
    },
    [api, channelId, mergeMessage]
  );

  const { members } = conversation;
  const clear = useCallback(
    async (command: ClearCommand) => {
      if (!(channelId && isOwner)) {
        throw new Error("Only workspace owners can start a new session.");
      }
      let agentIds: string[] | undefined;
      if (command.agentName) {
        const wanted = command.agentName.toLowerCase();
        const agent = agents.find(
          (entry) => entry.name.toLowerCase() === wanted
        );
        if (!agent || members.every((m) => m.memberId !== agent.id)) {
          throw new Error(
            `No agent named "${command.agentName}" in this channel.`
          );
        }
        agentIds = [agent.id];
      }
      await api.clearChannel(channelId, { agentIds });
    },
    [agents, api, channelId, isOwner, members]
  );

  if (!channel) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="m-0 font-medium text-sm">No conversation selected</p>
        <p className="m-0 text-[var(--ws-muted)] text-sm">
          Pick a channel or an agent in the sidebar, or use ＋ to create one.
        </p>
      </section>
    );
  }

  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      data-testid="conversation"
    >
      <ChannelHeader
        agents={agents}
        agentsById={agentsById}
        conversation={conversation}
        onChannelDeleted={onChannelDeleted}
        onSelectAgent={onSelectAgent}
        onToggleRail={onToggleRail}
      />
      {conversation.error ? (
        <p className="px-4 py-2 text-[var(--ws-danger)] text-xs">
          {conversation.error}
        </p>
      ) : null}
      {conversation.loading ? (
        <p className="px-4 py-2 text-[var(--ws-muted)] text-xs">
          Loading messages…
        </p>
      ) : null}
      <MessageStream
        agentsById={agentsById}
        key={channel.id}
        messages={conversation.messages}
        nextCursor={conversation.nextCursor}
        onAnswerQuestion={conversation.applyQuestion}
        onLoadOlder={conversation.loadOlder}
        onOpenThread={onOpenThread}
        onSelectAgent={onSelectAgent}
        viewer={viewer}
      />
      <AgentActivity
        statuses={conversation.agentStatuses}
        suppressed={conversation.suppressed}
      />
      <Composer
        agents={agents}
        onClear={clear}
        onSend={send}
        placeholder={
          channel.kind === "dm"
            ? `Message ${channel.name}`
            : `Message # ${channel.name}`
        }
      />
    </section>
  );
}
