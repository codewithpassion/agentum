import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { roomForInboxLink } from "#/components/room/room-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";

const searchSchema = z.object({
  thread: z.string().min(1).optional().catch(undefined),
});

/** The topic's team (null for a topic from before teams), or undefined when there is no topic to open or it can't be read. */
const teamOfThread = async (threadId: string | undefined) => {
  if (threadId === undefined) {
    return;
  }
  const found = await getTrpc().inbox.topicTeam.query({ threadId });
  return found?.teamId;
};

/** The inbox became team rooms: this sends the old URL to the topic's room, or to Everyone's. A topic that can't be read goes to Everyone with no topic open. */
export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (search) => searchSchema.parse(search),
  beforeLoad: async ({ search }) => {
    const { teamId, topic } = await loadOrLogin(async () => {
      const [teams, threadTeamId] = await Promise.all([
        getTrpc().teams.list.query(),
        teamOfThread(search.thread),
      ]);
      return {
        teamId: roomForInboxLink(teams, threadTeamId ?? null),
        // A topic that can't be read opens the room's topic list, not a dead panel.
        topic: threadTeamId === undefined ? undefined : search.thread,
      };
    });
    if (teamId === null) {
      throw redirect({ replace: true, to: "/home" });
    }
    throw redirect({
      params: { teamId },
      replace: true,
      search: { topic },
      to: "/teams/$teamId/room",
    });
  },
});
