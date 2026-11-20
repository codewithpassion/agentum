import type { EventsService } from "../events.ts";

/** What a failed send to a team's Slack channel says about itself. */
export interface RoomSendFailure {
  /** The agent whose message or request card it was, when there is one. */
  agentId?: string | null;
  channelId: string;
  /** The Slack error, or `no_app` when no member agent has an app in the channel's Slack workspace. */
  error: string;
  postId?: string;
  requestId?: string;
  slackTeamId: string;
  teamId: string;
  threadId?: string;
  workspaceId: string;
}

/**
 * Records that Slack did not take something from a team room after every try.
 * The event is what the team owner's Needs you problem item is read from
 * (`desk.railSources`). Never throws: the post or the request it is about has
 * already been written.
 */
export const reportRoomFailure = async (
  events: Pick<EventsService, "append">,
  failure: RoomSendFailure
): Promise<void> => {
  console.warn("Slack room send failed", failure.error);
  try {
    await events.append({
      actor: { id: "slack", kind: "system" },
      agentId: failure.agentId ?? null,
      payload: {
        channelId: failure.channelId,
        error: failure.error,
        slackTeamId: failure.slackTeamId,
        teamId: failure.teamId,
        ...(failure.threadId === undefined
          ? {}
          : { threadId: failure.threadId }),
        ...(failure.postId === undefined ? {} : { postId: failure.postId }),
        ...(failure.requestId === undefined
          ? {}
          : { requestId: failure.requestId }),
      },
      type: "slack.room_send_failed",
      workspaceId: failure.workspaceId,
    });
  } catch (error) {
    console.error("Slack room failure not recorded", error);
  }
};
