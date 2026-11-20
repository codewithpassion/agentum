import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { roomForInboxLink } from "#/components/room/room-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { hasTrpcCode, loadOrLogin } from "#/integrations/trpc/load-or-login";

const searchSchema = z.object({
  thread: z.string().min(1).optional().catch(undefined),
});

/** The topic's team, or null when the topic can't be read: the link then lands in Everyone. */
const teamOfThread = async (threadId: string | undefined) => {
  if (threadId === undefined) {
    return null;
  }
  try {
    const view = await getTrpc().inbox.readThread.query({ threadId });
    return view.thread.teamId;
  } catch (error) {
    if (hasTrpcCode(error, "UNAUTHORIZED")) {
      throw error;
    }
    return null;
  }
};

/** The inbox became team rooms: this sends the old URL to the topic's room, or to Everyone's. */
export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (search) => searchSchema.parse(search),
  beforeLoad: async ({ search }) => {
    const teamId = await loadOrLogin(async () => {
      const [teams, threadTeamId] = await Promise.all([
        getTrpc().teams.list.query(),
        teamOfThread(search.thread),
      ]);
      return roomForInboxLink(teams, threadTeamId);
    });
    if (teamId === null) {
      throw redirect({ replace: true, to: "/home" });
    }
    throw redirect({
      params: { teamId },
      replace: true,
      search: { topic: search.thread },
      to: "/teams/$teamId/room",
    });
  },
});
