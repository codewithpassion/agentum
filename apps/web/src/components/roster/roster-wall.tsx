import type { AgentCard, Team } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { LayoutTemplate, type LucideIcon, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { RailLink } from "#/components/rail/rail-link.tsx";
import { AddAgentDialog } from "#/components/team/add-agent-dialog.tsx";
import { AgentCardView } from "./agent-card.tsx";
import {
  groupCards,
  type NeedsYouChip,
  readCollapsed,
  sortCards,
  toggleKey,
  wallIsFlat,
  writeCollapsed,
} from "./roster-logic.ts";
import { TeamGroup } from "./team-group.tsx";

const CHIP_CLASS =
  "max-w-full truncate rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-sm";

const ADD_CARD_CLASS =
  "flex min-h-28 items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-sm font-medium text-muted-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

// Both link to /agents/new, the agent builder.
const ADD_CARDS: readonly { icon: LucideIcon; label: string }[] = [
  { icon: Plus, label: "New agent" },
  { icon: LayoutTemplate, label: "Start from a template" },
];

/** The dashed card at the end of a team group. It opens the member picker. */
const AddToTeamCard = ({
  onPick,
  team,
}: {
  onPick: (teamId: string) => void;
  team: Team;
}) => {
  const open = useCallback(() => onPick(team.id), [onPick, team.id]);
  return (
    <li>
      <button
        aria-label={`Add to team ${team.name}`}
        className={`${ADD_CARD_CLASS} w-full`}
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

/** The browser's storage, read lazily because blocked storage throws on access. */
const browserStorage = () => window.localStorage;

const AddCards = () =>
  ADD_CARDS.map(({ icon: Icon, label }) => (
    <li key={label}>
      <Link className={ADD_CARD_CLASS} to="/agents/new">
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

/**
 * The Roster home: agents grouped by home team, with agents in no team last.
 * A team with no agents has no group. When no team exists, or every agent is
 * in "Everyone" or in no team, the cards stay in one flat wall with no
 * headings. A group collapses, and the person's choice is kept in local
 * storage. With no agents, `emptyState` replaces the "No agents yet" line and
 * the add cards.
 */
export const RosterWall = ({
  cards,
  chips,
  emptyState,
  onAddMember,
  teams,
  userId,
}: {
  cards: readonly AgentCard[];
  chips: readonly NeedsYouChip[];
  emptyState?: ReactNode;
  /** Adds an agent to a team. A rejected promise shows its message in the picker. */
  onAddMember: (teamId: string, agentId: string) => Promise<void>;
  teams: readonly Team[];
  userId: string;
}) => {
  const isEmpty = cards.length === 0;
  const showEmptyState = isEmpty && emptyState !== undefined;
  const groups = isEmpty || teams.length === 0 ? [] : groupCards(cards, teams);
  const showGroups = !wallIsFlat(groups);
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
      {showEmptyState || showGroups ? null : (
        <ul className={GRID_CLASS}>
          {sortCards(cards).map((card) => (
            <li key={card.id}>
              <AgentCardView card={card} />
            </li>
          ))}
          <AddCards />
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
              <ul className={GRID_CLASS}>
                {group.cards.map((card) => (
                  <li key={card.id}>
                    <AgentCardView card={card} />
                  </li>
                ))}
                {group.team === null ? null : (
                  <AddToTeamCard onPick={setPickingTeamId} team={group.team} />
                )}
              </ul>
            </TeamGroup>
          ))
        : null}
      {showGroups ? (
        <ul className={GRID_CLASS}>
          <AddCards />
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
