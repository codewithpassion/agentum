import type { AgentCard, Team } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import {
  LayoutGrid,
  LayoutTemplate,
  List,
  type LucideIcon,
  Plus,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { RailLink } from "#/components/rail/rail-link.tsx";
import { AddAgentDialog } from "#/components/team/add-agent-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { cn } from "#/lib/utils";
import { AgentCardView, CARD_SIZE_CLASS } from "./agent-card.tsx";
import { AgentRowView } from "./agent-row.tsx";
import {
  filterCards,
  groupCards,
  type NeedsYouChip,
  type RosterView,
  readCollapsed,
  readView,
  sortCards,
  startsSearch,
  toggleKey,
  wallIsFlat,
  writeCollapsed,
  writeView,
} from "./roster-logic.ts";
import { TeamGroup } from "./team-group.tsx";

const CHIP_CLASS =
  "max-w-full truncate rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm";

const ADD_CARD_CLASS =
  "flex items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-sm font-medium text-muted-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

// Both link to /agents/new, the agent builder.
const ADD_CARDS: readonly { icon: LucideIcon; label: string }[] = [
  { icon: Plus, label: "New agent" },
  { icon: LayoutTemplate, label: "Start from a template" },
];

/** The dashed card at the end of a team group. It opens the member picker. */
const AddToTeamCard = ({
  onPick,
  team,
  view,
}: {
  onPick: (teamId: string) => void;
  team: Team;
  view: RosterView;
}) => {
  const open = useCallback(() => onPick(team.id), [onPick, team.id]);
  return (
    <li>
      <button
        aria-label={`Add to team ${team.name}`}
        className={
          view === "list"
            ? `${LIST_ADD_CLASS} w-full`
            : `${ADD_CARD_CLASS} ${CARD_SIZE_CLASS} w-full`
        }
        onClick={open}
        type="button"
      >
        <Plus aria-hidden="true" className="size-4 shrink-0" />
        Add to team
      </button>
    </li>
  );
};

const NeedsYouStrip = ({ chips }: { chips: readonly NeedsYouChip[] }) => (
  <section aria-label="Needs you" className="mb-6 flex flex-col gap-2">
    <h2 className="text-muted-foreground text-sm">Needs you</h2>
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => (
        <RailLink className={CHIP_CLASS} href={chip.href} key={chip.id}>
          {chip.title}
        </RailLink>
      ))}
    </div>
  </section>
);

const GRID_CLASS = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";
const LIST_CLASS = "flex flex-col gap-2";
const LIST_ADD_CLASS =
  "flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm font-medium text-muted-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

/** The browser's storage, read lazily because blocked storage throws on access. */
const browserStorage = () => window.localStorage;

const AddCards = ({ view }: { view: RosterView }) =>
  ADD_CARDS.map(({ icon: Icon, label }) => (
    <li key={label}>
      <Link
        className={
          view === "list" ? LIST_ADD_CLASS : cn(ADD_CARD_CLASS, CARD_SIZE_CLASS)
        }
        to="/agents/new"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </Link>
    </li>
  ));

/** Which groups are collapsed for this person. It reads storage after mount, so the server and the first client render agree. */
const useCollapsedGroups = (userId: string) => {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setCollapsed(readCollapsed(browserStorage, userId));
  }, [userId]);
  const toggle = useCallback(
    (key: string) => {
      const next = toggleKey(collapsed, key);
      setCollapsed(next);
      writeCollapsed(browserStorage, userId, next);
    },
    [collapsed, userId]
  );
  return { collapsed, toggle };
};

/** The card grid or row list the person chose. It reads storage after mount, so the server and the first client render agree. */
const useRosterView = () => {
  const [view, setView] = useState<RosterView>("grid");
  useEffect(() => {
    setView(readView(browserStorage));
  }, []);
  const choose = useCallback((next: RosterView) => {
    setView(next);
    writeView(browserStorage, next);
  }, []);
  return { choose, view };
};

/** True when focus sits where a typed letter belongs to the field, so it must not open the search. */
const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], [role=alertdialog]"
    ) !== null);

/**
 * The name filter. A plain printable key pressed outside a field opens it with
 * that character, and Esc clears it and closes it. `query` is null while closed.
 */
const useNameSearch = (enabled: boolean) => {
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQuery(null);
        return;
      }
      if (
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        !startsSearch(event)
      ) {
        return;
      }
      event.preventDefault();
      setQuery((current) => `${current ?? ""}${event.key}`);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
  return { query, setQuery };
};

const SearchField = ({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) => {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    [onChange]
  );
  return (
    <Input
      aria-label="Filter agents by name"
      autoFocus
      className="max-w-xs"
      onChange={handleChange}
      placeholder="Filter by name"
      type="search"
      value={value}
    />
  );
};

const ViewToggle = ({
  onChoose,
  view,
}: {
  onChoose: (view: RosterView) => void;
  view: RosterView;
}) => {
  const showGrid = useCallback(() => onChoose("grid"), [onChoose]);
  const showList = useCallback(() => onChoose("list"), [onChoose]);
  return (
    <div className="ml-auto flex gap-1">
      <Button
        aria-label="Card view"
        aria-pressed={view === "grid"}
        onClick={showGrid}
        size="icon"
        type="button"
        variant={view === "grid" ? "secondary" : "ghost"}
      >
        <LayoutGrid aria-hidden="true" />
      </Button>
      <Button
        aria-label="List view"
        aria-pressed={view === "list"}
        onClick={showList}
        size="icon"
        type="button"
        variant={view === "list" ? "secondary" : "ghost"}
      >
        <List aria-hidden="true" />
      </Button>
    </div>
  );
};

/** The search field and view toggle above the wall, and the line shown when no agent matches. */
const WallToolbar = ({
  noMatch,
  onChoose,
  onQuery,
  query,
  view,
}: {
  noMatch: boolean;
  onChoose: (view: RosterView) => void;
  onQuery: (value: string) => void;
  query: string | null;
  view: RosterView;
}) => (
  <>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {query === null ? null : <SearchField onChange={onQuery} value={query} />}
      <ViewToggle onChoose={onChoose} view={view} />
    </div>
    {noMatch ? (
      <p className="mb-4 text-muted-foreground text-sm">
        No agent matches "{query}".
      </p>
    ) : null}
  </>
);

/**
 * The Roster home: agents grouped by home team, with agents in no team last.
 * A team with no agents has no group. When no team exists, or every agent is
 * in "Everyone" or in no team, the cards stay in one flat wall with no
 * headings. A group collapses, and the person's choice is kept in local
 * storage. With no agents, `emptyState` replaces the "No agents yet" line and
 * the add cards. Typing a letter outside a field filters the agents by name,
 * and a toggle switches between the cards and a compact list.
 */
export const RosterWall = ({
  cards,
  chips,
  emptyState,
  onAddMember,
  teams,
  userId,
  weekCents,
}: {
  cards: readonly AgentCard[];
  chips: readonly NeedsYouChip[];
  emptyState?: ReactNode;
  /** Adds an agent to a team. A rejected promise shows its message in the picker. */
  onAddMember: (teamId: string, agentId: string) => Promise<void>;
  teams: readonly Team[];
  userId: string;
  /** This week's spend per agent id, from the Spend page's rows. An agent with no entry spent nothing. */
  weekCents: ReadonlyMap<string, number>;
}) => {
  const isEmpty = cards.length === 0;
  const showEmptyState = isEmpty && emptyState !== undefined;
  const { choose, view } = useRosterView();
  const { query, setQuery } = useNameSearch(!isEmpty);
  const visible = filterCards(cards, query ?? "");
  const hasTeams = !isEmpty && teams.length > 0;
  const showGroups = hasTeams && !wallIsFlat(groupCards(cards, teams));
  const groups = showGroups ? groupCards(visible, teams) : [];
  const noMatch = visible.length === 0;
  const listClass = view === "list" ? LIST_CLASS : GRID_CLASS;
  const CardView = view === "list" ? AgentRowView : AgentCardView;
  const { collapsed, toggle } = useCollapsedGroups(userId);
  const [pickingTeamId, setPickingTeamId] = useState<string | null>(null);
  const closePicker = useCallback(() => setPickingTeamId(null), []);
  const pickingTeam = teams.find((team) => team.id === pickingTeamId);
  return (
    <div>
      {chips.length > 0 ? <NeedsYouStrip chips={chips} /> : null}
      {showEmptyState ? emptyState : null}
      {isEmpty && !showEmptyState ? (
        <p className="mb-4 text-muted-foreground text-sm">
          No agents yet. Describe your first job and an agent will do it.
        </p>
      ) : null}
      {isEmpty ? null : (
        <WallToolbar
          noMatch={noMatch}
          onChoose={choose}
          onQuery={setQuery}
          query={query}
          view={view}
        />
      )}
      {showEmptyState || showGroups ? null : (
        <ul className={listClass} data-view={view}>
          {sortCards(visible).map((card) => (
            <li key={card.id}>
              <CardView card={card} weekCents={weekCents.get(card.id) ?? 0} />
            </li>
          ))}
          <AddCards view={view} />
        </ul>
      )}
      {showGroups
        ? groups.map((group) => (
            <TeamGroup
              collapsed={collapsed.has(group.key)}
              group={group}
              key={group.key}
              onToggle={toggle}
            >
              <ul className={listClass} data-view={view}>
                {group.cards.map((card) => (
                  <li key={card.id}>
                    <CardView
                      card={card}
                      weekCents={weekCents.get(card.id) ?? 0}
                    />
                  </li>
                ))}
                {group.team === null ? null : (
                  <AddToTeamCard
                    onPick={setPickingTeamId}
                    team={group.team}
                    view={view}
                  />
                )}
              </ul>
            </TeamGroup>
          ))
        : null}
      {showGroups ? (
        <ul className={listClass} data-view={view}>
          <AddCards view={view} />
        </ul>
      ) : null}
      {pickingTeam === undefined ? null : (
        <AddAgentDialog
          agents={cards}
          onAdd={onAddMember}
          onClose={closePicker}
          team={pickingTeam}
        />
      )}
    </div>
  );
};
