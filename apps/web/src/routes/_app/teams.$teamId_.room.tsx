import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { RoomNotFound, RoomPage } from "#/components/room/room-page.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

const searchSchema = z.object({
  topic: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/teams/$teamId_/room")({
  validateSearch: (search) => searchSchema.parse(search),
  loader: async ({ params }) =>
    loadOrLogin(async () => {
      const trpc = getTrpc();
      const [team, agents, threads, me, people] = await Promise.all([
        trpc.teams.get.query({ teamId: params.teamId }),
        trpc.roster.list.query(),
        trpc.inbox.listThreads.query({ teamId: params.teamId }),
        trpc.me.query(),
        // Names are a nicety: without them a person shows as "Teammate".
        trpc.members.list.query().catch(() => []),
      ]);
      const profiles = await Promise.all(
        people.map((person) =>
          trpc.teams.profiles.get
            .query({ userId: person.userId })
            .catch(() => null)
        )
      );
      const handles = new Map(
        profiles.flatMap((profile) =>
          profile === null ? [] : [[profile.userId, profile.handle] as const]
        )
      );
      return { agents, handles, people, team, threads, userId: me.userId };
    }, ["NOT_FOUND"]),
  notFoundComponent: RoomNotFound,
  component: TeamRoomRoute,
});

function TeamRoomRoute() {
  const { agents, handles, people, team, threads, userId } =
    Route.useLoaderData();
  const { topic } = Route.useSearch();
  const navigate = Route.useNavigate();
  const openTopic = useCallback(
    (topicId: string) => navigate({ search: { topic: topicId } }),
    [navigate]
  );
  return (
    <RoomPage
      agents={agents}
      handles={handles}
      onOpenTopic={openTopic}
      people={people}
      team={team}
      threads={threads}
      topicId={topic}
      userId={userId}
    />
  );
}
