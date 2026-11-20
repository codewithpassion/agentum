import { useAuth } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { NewTeamButton } from "#/components/team/new-team-button";
import { TeamList } from "#/components/team/team-list";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

export const PAGE_HEADING = "Teams";

export const Route = createFileRoute("/_app/teams/")({
  loader: async () =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      const [teams, agents, people] = await Promise.all([
        trpc.teams.list.query(),
        trpc.roster.list.query(),
        trpc.members.list.query().catch(() => null),
      ]);
      return { agents, people, teams };
    }),
  component: TeamsPage,
});

function TeamsPage() {
  const { agents, people, teams } = Route.useLoaderData();
  const { userId } = useAuth();
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-3xl text-foreground">
          {PAGE_HEADING}
        </h1>
        <NewTeamButton agents={agents} people={people} youId={userId} />
      </div>
      <TeamList agents={agents} teams={teams} />
    </section>
  );
}
