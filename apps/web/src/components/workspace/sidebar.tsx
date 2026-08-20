import { UserButton } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { WorkspaceSwitcher } from "#/components/tenant/workspace-switcher";
import ThemeToggle from "#/components/theme-toggle";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import type { Agent, CategoryView, Channel } from "#/lib/api";
import { cx } from "#/lib/cx";
import { useApi, useWorkspaceSlug } from "#/lib/workspace-context";
import { CategoryDialog } from "./category-dialog";
import { CONNECTORS_SECTION, ConnectorsSection } from "./connectors-section";
import { ItemCategoryMenu, MENU_ITEM_CLASS } from "./sidebar-menu";
import { SectionHint, SidebarSection } from "./sidebar-section";
import { SKILLS_SECTION, SkillsSection } from "./skills-section";

const COLLAPSED_KEY = "ws-sidebar-collapsed";
const CHANNELS_SECTION = "channels";
const AGENTS_SECTION = "agents";

const categorySection = (categoryId: string): string =>
  `category:${categoryId}`;

const matches = (name: string, query: string): boolean =>
  name.toLowerCase().includes(query.trim().toLowerCase());

const rowClass = (active: boolean): string =>
  cx(
    "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]",
    active
      ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
      : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
  );

const ICON_LINK_CLASS =
  "ws-focus inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-transparent bg-transparent text-[var(--ws-muted)] no-underline transition hover:bg-[var(--ws-surface-hover)] hover:text-[var(--ws-text)]";

const readCollapsed = (): string[] => {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
};

/**
 * Collapsed sections persist as a JSON array of section keys. It is read after
 * mount rather than in a state initialiser, so the server and client render the
 * same first pass.
 */
const useCollapsedSections = () => {
  const [collapsed, setCollapsed] = useState<string[]>([]);

  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

  const toggle = useCallback(
    (sectionKey: string) => {
      const next = collapsed.includes(sectionKey)
        ? collapsed.filter((key) => key !== sectionKey)
        : [...collapsed, sectionKey];
      setCollapsed(next);
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    },
    [collapsed]
  );

  return { collapsed, toggle };
};

/** Everything a row needs that does not change between sections. */
interface RowContext {
  activeAgentId: string | null;
  activeChannelId: string | null;
  categories: CategoryView[];
  onOpenChannel: (channelId: string) => void;
  onOpenDm: (agent: Agent) => void;
  onReload: () => Promise<void>;
  onSelectAgent: (agentId: string) => void;
}

function ChannelRow({
  categoryId,
  channel,
  context,
}: {
  categoryId: string | null;
  channel: Channel;
  context: RowContext;
}) {
  const { onOpenChannel } = context;
  const open = useCallback(
    () => onOpenChannel(channel.id),
    [channel.id, onOpenChannel]
  );

  return (
    <div className="group flex items-center gap-1">
      <button
        className={rowClass(channel.id === context.activeChannelId)}
        onClick={open}
        type="button"
      >
        <span aria-hidden="true" className="text-[var(--ws-muted)]">
          #
        </span>
        <span className="truncate">{channel.name}</span>
      </button>
      <ItemCategoryMenu
        categories={context.categories}
        categoryId={categoryId}
        itemId={channel.id}
        itemName={channel.name}
        itemType="channel"
        onChanged={context.onReload}
      />
    </div>
  );
}

function AgentRow({
  agent,
  categoryId,
  context,
}: {
  agent: Agent;
  categoryId: string | null;
  context: RowContext;
}) {
  const { onOpenDm, onSelectAgent } = context;
  const openDm = useCallback(() => onOpenDm(agent), [agent, onOpenDm]);
  const selectAgent = useCallback(
    () => onSelectAgent(agent.id),
    [agent.id, onSelectAgent]
  );

  return (
    <div className="group flex items-center gap-1">
      <button
        className={rowClass(agent.id === context.activeAgentId)}
        onClick={openDm}
        title={`Message ${agent.name}`}
        type="button"
      >
        <Avatar color={agent.avatar} name={agent.name} size="sm" />
        <span className="truncate">{agent.name}</span>
      </button>
      <ItemCategoryMenu
        categories={context.categories}
        categoryId={categoryId}
        itemId={agent.id}
        itemName={agent.name}
        itemType="agent"
        onChanged={context.onReload}
      />
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

function SectionRows({
  agents,
  categoryId,
  channels,
  context,
  emptyHint,
}: {
  agents: Agent[];
  categoryId: string | null;
  channels: Channel[];
  context: RowContext;
  emptyHint: string;
}) {
  if (channels.length === 0 && agents.length === 0) {
    return <SectionHint>{emptyHint}</SectionHint>;
  }

  return (
    <>
      {channels.map((channel) => (
        <ChannelRow
          categoryId={categoryId}
          channel={channel}
          context={context}
          key={channel.id}
        />
      ))}
      {agents.map((agent) => (
        <AgentRow
          agent={agent}
          categoryId={categoryId}
          context={context}
          key={agent.id}
        />
      ))}
    </>
  );
}

function CategorySection({
  agents,
  category,
  channels,
  context,
  expanded,
  onRename,
  onToggle,
}: {
  agents: Agent[];
  category: CategoryView;
  channels: Channel[];
  context: RowContext;
  expanded: boolean;
  onRename: (category: CategoryView) => void;
  onToggle: (sectionKey: string) => void;
}) {
  const api = useApi();

  const [menuOpen, setMenuOpen] = useState(false);
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const { onReload } = context;

  const rename = useCallback(() => {
    setMenuOpen(false);
    onRename(category);
  }, [category, onRename]);

  // Deleting a category only unlinks its items, so there is nothing to confirm.
  const remove = useCallback(() => {
    setMenuOpen(false);
    (async () => {
      await api.deleteCategory(category.id);
      await onReload();
    })();
  }, [api, category.id, onReload]);

  return (
    <SidebarSection
      actions={
        <div className="relative">
          <Button
            aria-label={`${category.name} options`}
            onClick={toggleMenu}
            size="icon"
            title={`${category.name} options`}
            variant="ghost"
          >
            <span aria-hidden="true">⋯</span>
          </Button>
          <Popover align="right" onClose={closeMenu} open={menuOpen}>
            <button className={MENU_ITEM_CLASS} onClick={rename} type="button">
              Rename
            </button>
            <button className={MENU_ITEM_CLASS} onClick={remove} type="button">
              Delete
            </button>
          </Popover>
        </div>
      }
      expanded={expanded}
      label={category.name}
      onToggle={onToggle}
      sectionKey={categorySection(category.id)}
    >
      <SectionRows
        agents={agents}
        categoryId={category.id}
        channels={channels}
        context={context}
        emptyHint="Empty"
      />
    </SidebarSection>
  );
}

interface SidebarModel {
  grouped: { agents: Agent[]; category: CategoryView; channels: Channel[] }[];
  looseAgents: Agent[];
  looseChannels: Channel[];
}

/** References to categories that no longer exist fall back to uncategorised. */
const buildModel = (
  agents: Agent[],
  categories: CategoryView[],
  channels: Channel[],
  query: string
): SidebarModel => {
  const owner = new Map<string, string>();
  for (const category of categories) {
    for (const item of category.items) {
      owner.set(`${item.itemType}:${item.itemId}`, category.id);
    }
  }

  const visibleChannels = channels.filter(
    (channel) => channel.kind === "channel" && matches(channel.name, query)
  );
  const visibleAgents = agents.filter((agent) => matches(agent.name, query));

  const channelOwner = (channel: Channel) =>
    owner.get(`channel:${channel.id}`) ?? null;
  const agentOwner = (agent: Agent) => owner.get(`agent:${agent.id}`) ?? null;

  return {
    grouped: categories.map((category) => ({
      agents: visibleAgents.filter(
        (agent) => agentOwner(agent) === category.id
      ),
      category,
      channels: visibleChannels.filter(
        (channel) => channelOwner(channel) === category.id
      ),
    })),
    looseAgents: visibleAgents.filter((agent) => agentOwner(agent) === null),
    looseChannels: visibleChannels.filter(
      (channel) => channelOwner(channel) === null
    ),
  };
};

export function Sidebar({
  activeAgentId,
  activeChannelId,
  agents,
  categories,
  channels,
  onNewAgent,
  onNewChannel,
  onOpenChannel,
  onOpenDm,
  onReload,
  onSelectAgent,
  viewerName,
}: {
  activeAgentId: string | null;
  activeChannelId: string | null;
  agents: Agent[];
  categories: CategoryView[];
  channels: Channel[];
  onNewAgent: () => void;
  onNewChannel: () => void;
  onOpenChannel: (channelId: string) => void;
  onOpenDm: (agent: Agent) => void;
  onReload: () => Promise<void>;
  onSelectAgent: (agentId: string) => void;
  viewerName: string;
}) {
  const workspaceSlug = useWorkspaceSlug();

  const searchId = useId();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editedCategory, setEditedCategory] = useState<{
    category: CategoryView | null;
  } | null>(null);
  const { collapsed, toggle } = useCollapsedSections();

  const model = useMemo(
    () => buildModel(agents, categories, channels, query),
    [agents, categories, channels, query]
  );

  const context: RowContext = useMemo(
    () => ({
      activeAgentId,
      activeChannelId,
      categories,
      onOpenChannel,
      onOpenDm,
      onReload,
      onSelectAgent,
    }),
    [
      activeAgentId,
      activeChannelId,
      categories,
      onOpenChannel,
      onOpenDm,
      onReload,
      onSelectAgent,
    ]
  );

  // A collapsed section would hide its matches, so searching expands everything.
  const searching = query.trim() !== "";
  const isExpanded = (sectionKey: string) =>
    searching || !collapsed.includes(sectionKey);

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
  const newCategory = useCallback(() => {
    setMenuOpen(false);
    setEditedCategory({ category: null });
  }, []);
  const startRename = useCallback(
    (category: CategoryView) => setEditedCategory({ category }),
    []
  );
  const closeCategoryDialog = useCallback(() => setEditedCategory(null), []);

  return (
    <nav
      aria-label="Workspace"
      className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <WorkspaceSwitcher />
        <div className="flex items-center gap-1">
          <Link
            aria-label="Wiki"
            className={ICON_LINK_CLASS}
            params={{ workspaceSlug }}
            title="Wiki"
            to="/w/$workspaceSlug/wiki"
          >
            <span aria-hidden="true">📓</span>
          </Link>
          <Link
            aria-label="Connectors"
            className={ICON_LINK_CLASS}
            params={{ workspaceSlug }}
            title="Connectors"
            to="/w/$workspaceSlug/connectors"
          >
            <span aria-hidden="true">🔌</span>
          </Link>
          <Link
            aria-label="Skills"
            className={ICON_LINK_CLASS}
            params={{ workspaceSlug }}
            title="Skills"
            to="/w/$workspaceSlug/skills"
          >
            <span aria-hidden="true">🧠</span>
          </Link>
          <div className="relative">
            <Button
              aria-label="Create"
              onClick={toggleMenu}
              size="icon"
              title="Create a channel, an agent or a category"
              variant="ghost"
            >
              <span aria-hidden="true">＋</span>
            </Button>
            <Popover align="right" onClose={closeMenu} open={menuOpen}>
              <button
                className={MENU_ITEM_CLASS}
                onClick={newChannel}
                type="button"
              >
                New channel
              </button>
              <button
                className={MENU_ITEM_CLASS}
                onClick={newAgent}
                type="button"
              >
                New agent
              </button>
              <button
                className={MENU_ITEM_CLASS}
                onClick={newCategory}
                type="button"
              >
                New category
              </button>
            </Popover>
          </div>
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
        <SidebarSection
          expanded={isExpanded(CHANNELS_SECTION)}
          label="Channels"
          onToggle={toggle}
          sectionKey={CHANNELS_SECTION}
        >
          <SectionRows
            agents={[]}
            categoryId={null}
            channels={model.looseChannels}
            context={context}
            emptyHint="No channels yet."
          />
        </SidebarSection>

        <SidebarSection
          expanded={isExpanded(AGENTS_SECTION)}
          label="Agents"
          onToggle={toggle}
          sectionKey={AGENTS_SECTION}
        >
          <SectionRows
            agents={model.looseAgents}
            categoryId={null}
            channels={[]}
            context={context}
            emptyHint="No agents yet."
          />
        </SidebarSection>

        <ConnectorsSection
          expanded={isExpanded(CONNECTORS_SECTION)}
          onToggle={toggle}
        />

        <SkillsSection
          expanded={isExpanded(SKILLS_SECTION)}
          onToggle={toggle}
        />

        {model.grouped.map((group) => (
          <CategorySection
            agents={group.agents}
            category={group.category}
            channels={group.channels}
            context={context}
            expanded={isExpanded(categorySection(group.category.id))}
            key={group.category.id}
            onRename={startRename}
            onToggle={toggle}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 border-[var(--ws-line)] border-t px-3 py-3">
        <UserButton />
        <span className="flex-1 truncate text-[var(--ws-muted)] text-xs">
          {viewerName}
        </span>
        <ThemeToggle />
      </div>

      <CategoryDialog
        category={editedCategory?.category ?? null}
        onClose={closeCategoryDialog}
        onSaved={onReload}
        open={editedCategory !== null}
      />
    </nav>
  );
}
