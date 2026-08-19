import { useCallback } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import {
  type Agent,
  type ChannelMemberView,
  type MessageView,
  postMessage,
} from "#/lib/api";
import type { Viewer } from "#/lib/authors";
import type { Conversation as ConversationState } from "#/lib/use-conversation";
import { AgentActivity } from "./agent-activity";
import { ChannelSettings } from "./channel-settings";
import { Composer } from "./composer";
import { MessageStream } from "./message-stream";

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
  onSelectAgent,
  onToggleRail,
}: {
  agents: Agent[];
  agentsById: Map<string, Agent>;
  conversation: ConversationState;
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
      <span className="text-[var(--ws-muted)] text-xs">
        {members.length} {members.length === 1 ? "member" : "members"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {channel ? (
          <ChannelSettings agents={agents} channelId={channel.id} />
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
  onOpenThread,
  onSelectAgent,
  onToggleRail,
  viewer,
}: {
  agents: Agent[];
  agentsById: Map<string, Agent>;
  conversation: ConversationState;
  onOpenThread: (message: MessageView) => void;
  onSelectAgent: (agentId: string) => void;
  onToggleRail: () => void;
  viewer: Viewer;
}) {
  const { channel, mergeMessage } = conversation;
  const channelId = channel?.id ?? null;

  const send = useCallback(
    async (input: { attachmentIds: string[]; body: string }) => {
      if (!channelId) {
        return;
      }
      mergeMessage(await postMessage(channelId, input));
    },
    [channelId, mergeMessage]
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
        messages={conversation.messages}
        nextCursor={conversation.nextCursor}
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
