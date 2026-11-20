import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useId } from "react";
import { RailLink } from "#/components/rail/rail-link.tsx";
import type { RosterGroup } from "./roster-logic.ts";

const LINK_CLASS =
  "inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2";

const NO_TEAM_NAME = "No team";

const agentCountText = (count: number): string =>
  count === 1 ? "1 agent" : `${count} agents`;

const needsYouText = (count: number): string =>
  count === 1 ? "1 needs you" : `${count} need you`;

/** The muted line under a group title: lead, agent count and waiting requests. */
const summaryFor = (group: RosterGroup): string => {
  const parts: string[] = [];
  if (group.team) {
    parts.push(group.leadName === null ? "No lead" : `Lead ${group.leadName}`);
  }
  parts.push(agentCountText(group.cards.length));
  if (group.needsYouCount > 0) {
    parts.push(needsYouText(group.needsYouCount));
  }
  return parts.join(" · ");
};

/** One group on the Roster home: a collapsible header and the group's cards. */
export const TeamGroup = ({
  children,
  collapsed,
  group,
  onToggle,
}: {
  children: ReactNode;
  collapsed: boolean;
  group: RosterGroup;
  onToggle: (key: string) => void;
}) => {
  const id = useId();
  const headingId = `${id}-heading`;
  const regionId = `${id}-region`;
  const { team } = group;
  const title = team ? team.name : NO_TEAM_NAME;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const handleToggle = useCallback(
    () => onToggle(group.key),
    [group.key, onToggle]
  );

  return (
    <section aria-labelledby={headingId} className="mb-8">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="min-w-0" id={headingId}>
            <button
              aria-controls={collapsed ? undefined : regionId}
              aria-expanded={!collapsed}
              className="flex min-w-0 items-center gap-2 text-left font-semibold text-lg"
              onClick={handleToggle}
              type="button"
            >
              <Chevron aria-hidden="true" className="shrink-0" size={18} />
              <span className="truncate">{title}</span>
            </button>
          </h2>
          <p className="text-muted-foreground text-sm">{summaryFor(group)}</p>
        </div>
        {team ? (
          <RailLink
            className={LINK_CLASS}
            href={`/teams/${encodeURIComponent(team.id)}/room`}
            label={`Open room for ${team.name}`}
          >
            Open room
          </RailLink>
        ) : null}
      </header>
      {collapsed ? null : <div id={regionId}>{children}</div>}
    </section>
  );
};
