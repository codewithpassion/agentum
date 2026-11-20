import type { Team } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import type { TeamAgent } from "./team-logic.ts";

/** "3 agents, 2 people", leaving out a kind that has none. */
export const memberSummary = (team: Pick<Team, "members">): string => {
  const agents = team.members.filter((member) => member.memberKind === "agent");
  const people = team.members.length - agents.length;
  const parts = [
    agents.length === 0
      ? null
      : `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`,
    people === 0 ? null : `${people} ${people === 1 ? "person" : "people"}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "No members yet" : parts.join(", ");
};

/** Every team of the workspace, each opening its page. */
export function TeamList({
  agents,
  teams,
}: {
  agents: readonly TeamAgent[];
  teams: readonly Team[];
}) {
  if (teams.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No teams yet. Create one to group agents and people in a room.
      </p>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {teams.map((team) => {
        const lead = agents.find((agent) => agent.id === team.leadAgentId);
        return (
          <li key={team.id}>
            <Link
              className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-4 text-card-foreground no-underline hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2"
              params={{ teamId: team.id }}
              to="/teams/$teamId"
            >
              <span className="truncate font-medium">{team.name}</span>
              <span className="text-muted-foreground text-sm">
                {memberSummary(team)}
              </span>
              <span className="text-muted-foreground text-sm">
                {lead === undefined ? "No lead" : `${lead.name} leads`}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
