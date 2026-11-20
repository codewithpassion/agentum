import { useAuth } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { canEditTeam } from "#/components/team/team-logic";
import { TeamPage } from "#/components/team/team-page";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const Route = createFileRoute("/_app/teams/$teamId")({
  loader: async ({ params }) =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      // The jobs list is for the standing jobs. A failed read leaves them out.
      const [team, agents, people, profile, jobs] = await Promise.all([
        trpc.teams.get.query({ teamId: params.teamId }),
        trpc.roster.list.query(),
        trpc.members.list.query().catch(() => null),
        trpc.teams.profiles.get.query({}),
        trpc.jobs.list.query().catch(() => null),
      ]);
      return { agents, jobs, people, profile, team };
    }, ["NOT_FOUND"]),
  component: TeamRoute,
});

function TeamRoute() {
  const { agents, jobs, people, profile, team } = Route.useLoaderData();
  const { orgRole, userId } = useAuth();
  const canEdit = canEditTeam({
    isAdmin: orgRole === "org:admin",
    ownerUserId: team.ownerUserId,
    userId,
  });
  return (
    <TeamPage
      agents={agents}
      canEdit={canEdit}
      jobs={jobs}
      people={people}
      profile={profile}
      team={team}
      userId={userId}
    />
  );
}
