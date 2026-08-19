import { UserButton } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useState } from "react";
import ThemeToggle from "#/components/theme-toggle";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import type { Agent, Channel } from "#/lib/api";
import { cx } from "#/lib/cx";

const matches = (name: string, query: string): boolean =>
  name.toLowerCase().includes(query.trim().toLowerCase());

const rowClass = (active: boolean): string =>
  cx(
    "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
    active
      ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
      : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
  );

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 px-2 pt-4 pb-1 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
      {children}
    </p>
  );
}

function ChannelRow({
  active,
  channel,
  onOpen,
}: {
  active: boolean;
  channel: Channel;
  onOpen: (channelId: string) => void;
}) {
  const open = useCallback(() => onOpen(channel.id), [channel.id, onOpen]);
  return (
    <button className={rowClass(active)} onClick={open} type="button">
      <span aria-hidden="true" className="text-[var(--ws-muted)]">
        #
      </span>
      <span className="truncate">{channel.name}</span>
    </button>
  );
}

function AgentRow({
  active,
  agent,
  onOpenDm,
  onSelectAgent,
}: {
  active: boolean;
  agent: Agent;
  onOpenDm: (agent: Agent) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const openDm = useCallback(() => onOpenDm(agent), [agent, onOpenDm]);
  const selectAgent = useCallback(
    () => onSelectAgent(agent.id),
    [agent.id, onSelectAgent]
  );

  return (
    <div className="flex items-center gap-1">
      <button
        className={rowClass(active)}
        onClick={openDm}
        title={`Message ${agent.name}`}
        type="button"
      >
        <Avatar color={agent.avatar} name={agent.name} size="sm" />
        <span className="truncate">{agent.name}</span>
      </button>
      <Button
        aria-label={`Open ${agent.name}'s profile`}
        onClick={selectAgent}
        size="icon"
        title={`Open ${agent.name}'s profile`}
        variant="ghost"
      >
        <span aria-hidden="true">›</span>
      </Button>
    </div>
  );
}

export function Sidebar({
  activeAgentId,
  activeChannelId,
  agents,
  channels,
  onNewAgent,
  onNewChannel,
  onOpenChannel,
  onOpenDm,
  onSelectAgent,
}: {
  activeAgentId: string | null;
  activeChannelId: string | null;
  agents: Agent[];
  channels: Channel[];
  onNewAgent: () => void;
  onNewChannel: () => void;
  onOpenChannel: (channelId: string) => void;
  onOpenDm: (agent: Agent) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const visibleChannels = channels.filter(
    (channel) => channel.kind === "channel" && matches(channel.name, query)
  );
  const visibleAgents = agents.filter((agent) => matches(agent.name, query));

  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const onQueryChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setQuery(event.target.value),
    []
  );

  const newChannel = useCallback(() => {
    setMenuOpen(false);
    onNewChannel();
  }, [onNewChannel]);
  const newAgent = useCallback(() => {
    setMenuOpen(false);
    onNewAgent();
  }, [onNewAgent]);

  return (
    <nav
      aria-label="Workspace"
      className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="font-semibold text-sm">Agentum</span>
        <div className="relative">
          <Button
            aria-label="Create"
            onClick={toggleMenu}
            size="icon"
            title="Create a channel or an agent"
            variant="ghost"
          >
            <span aria-hidden="true">＋</span>
          </Button>
          <Popover align="right" onClose={closeMenu} open={menuOpen}>
            <button
              className="ws-focus block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--ws-surface-hover)]"
              onClick={newChannel}
              type="button"
            >
              New channel
            </button>
            <button
              className="ws-focus block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--ws-surface-hover)]"
              onClick={newAgent}
              type="button"
            >
              New agent
            </button>
          </Popover>
        </div>
      </div>

      <div className="px-3">
        <label className="sr-only" htmlFor={searchId}>
          Search channels and agents
        </label>
        <input
          className="ws-focus w-full rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-2.5 py-1.5 text-[13px] text-[var(--ws-text)] placeholder:text-[var(--ws-muted)]"
          id={searchId}
          onChange={onQueryChange}
          placeholder="Search"
          type="search"
          value={query}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <SectionLabel>Channels</SectionLabel>
        {visibleChannels.length === 0 ? (
          <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
            No channels yet.
          </p>
        ) : null}
        {visibleChannels.map((channel) => (
          <ChannelRow
            active={channel.id === activeChannelId}
            channel={channel}
            key={channel.id}
            onOpen={onOpenChannel}
          />
        ))}

        <SectionLabel>Direct messages</SectionLabel>
        {visibleAgents.length === 0 ? (
          <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
            No agents yet.
          </p>
        ) : null}
        {visibleAgents.map((agent) => (
          <AgentRow
            active={agent.id === activeAgentId}
            agent={agent}
            key={agent.id}
            onOpenDm={onOpenDm}
            onSelectAgent={onSelectAgent}
          />
        ))}

        <SectionLabel>Knowledge</SectionLabel>
        <Link
          className={cx(rowClass(false), "no-underline")}
          title="Open the wiki"
          to="/wiki"
        >
          <span aria-hidden="true">📓</span>
          Wiki
        </Link>
      </div>

      <div className="flex items-center gap-2 border-[var(--ws-line)] border-t px-3 py-3">
        <UserButton />
        <span className="flex-1 truncate text-[var(--ws-muted)] text-xs">
          Signed in
        </span>
        <ThemeToggle />
      </div>
    </nav>
  );
}
