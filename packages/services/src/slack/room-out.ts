/**
 * A post in a team room whose team is linked to a Slack channel goes out to
 * that channel. `onEvent` hears `inbox.posted` for every post, whoever wrote
 * it, and sends the ones that did not come from Slack: a post that already has
 * a `slack_room_messages` row is an inbound message (or a send that already
 * happened) and is left alone, which is what keeps Slack's own messages from
 * echoing back into the room.
 *
 * An agent's post goes out through that agent's own Slack app. A person's post
 * goes out through the lead's app, or the oldest member app when the team has
 * no lead, with the person's name in front. An app that is not in the channel
 * (or has no token, or no app) makes the send move to the next member app, and
 * a post that goes out under another agent's app carries the author's name.
 * The first post of a topic opens a Slack thread and later ones reply in it.
 * `withRetry` makes up to three tries per app. When no app takes the post, a
 * `slack.room_send_failed` event is recorded and the team owner sees a problem
 * item in Needs you.
 */
import type { Database } from "@repo/db";
import { inboxPosts } from "@repo/db/schema/inbox";
import { memberProfiles } from "@repo/db/schema/teams";
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { findAgent } from "../agents.ts";
import { personLabel } from "../events/summary.ts";
import type { EventRecord, EventsService, PeopleLookup } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import {
  createSecretReader,
  findInstalledApp,
  type SecretReader,
  type SlackAppRow,
} from "./apps.ts";
import { createSlackClient, type SlackFetch } from "./client.ts";
import { describeFailure, withRetry } from "./post.ts";
import { reportRoomFailure } from "./room-failure.ts";
import {
  findOutboundRoom,
  memberSenderApps,
  type OutboundRoom,
  recordOutMessage,
  roomMessageOfPost,
  topicRootTs,
} from "./room-out-store.ts";
import { cutForSlack, speakerLine } from "./room-out-text.ts";

const NO_APP = "no_app";
const UNREADABLE_TOKEN = "token_unreadable";

type PostRow = typeof inboxPosts.$inferSelect;

/** An app that may send, and whether it is the author's own. */
interface Sender {
  app: SlackAppRow;
  own: boolean;
}

type SendResult =
  | { kind: "sent"; ts: string }
  | { error: string; kind: "next" }
  | { error: string; kind: "failed" };

export interface RoomOutboundOptions {
  clock: Clock;
  db: Database;
  /** Runs the send after the response (`waitUntil`). Without it, the send is awaited. */
  defer?: (work: Promise<void>) => void;
  events: Pick<EventsService, "append">;
  fetch: SlackFetch;
  /** Names a person who has no room profile. */
  people?: PeopleLookup;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}

export const createRoomOutbound = ({
  clock,
  db,
  defer,
  events,
  fetch: slackFetch,
  people,
  secretsKey,
}: RoomOutboundOptions) => {
  const secrets: SecretReader = createSecretReader(secretsKey);

  /** The name a person's post carries in Slack: their room profile, else the directory. */
  const personName = async (
    workspaceId: string,
    userId: string
  ): Promise<string | null> => {
    const [profile] = await db
      .select({ name: memberProfiles.name })
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.workspaceId, workspaceId),
          eq(memberProfiles.userId, userId)
        )
      )
      .limit(1);
    if (profile) {
      return profile.name;
    }
    try {
      const found = people ? (await people([userId])).get(userId) : undefined;
      return personLabel(found) ?? null;
    } catch (error) {
      console.error("Slack room person lookup failed", error);
      return null;
    }
  };

  const authorName = async (post: PostRow): Promise<string | null> => {
    if (post.authorKind !== "agent") {
      return await personName(post.workspaceId, post.authorId);
    }
    const agent = await findAgent(db, {
      id: post.authorId,
      workspaceId: post.workspaceId,
    });
    return agent ? agent.name : null;
  };

  /** The apps to try, in order: the author's own, the lead's, then the other members'. */
  const sendersFor = async (
    post: PostRow,
    room: OutboundRoom
  ): Promise<Sender[]> => {
    const members = await memberSenderApps(db, {
      slackTeamId: room.slackTeamId,
      teamId: room.teamId,
      workspaceId: post.workspaceId,
    });
    const own =
      post.authorKind === "agent"
        ? await findInstalledApp(db, {
            agentId: post.authorId,
            teamId: room.slackTeamId,
            workspaceId: post.workspaceId,
          })
        : null;
    const others = [
      ...members.filter(({ agentId }) => agentId === room.leadAgentId),
      ...members.filter(({ agentId }) => agentId !== room.leadAgentId),
    ].filter(({ app }) => app.id !== own?.id);
    return [
      ...(own ? [{ app: own, own: true }] : []),
      ...others.map(({ app }) => ({ app, own: false })),
    ];
  };

  /** One app's try. A config failure (not in the channel, a bad token) moves on to the next app. */
  const sendThrough = async (
    sender: Sender,
    message: { channel: string; text: string; threadTs: string | undefined }
  ): Promise<SendResult> => {
    let token: string | null;
    try {
      token = await secrets.botToken(sender.app);
    } catch {
      return { error: UNREADABLE_TOKEN, kind: "next" };
    }
    if (token === null) {
      return { error: NO_APP, kind: "next" };
    }
    const client = createSlackClient({ fetch: slackFetch, token });
    const posted = await withRetry(clock, () => client.postMessage(message));
    if (posted.kind === "ok") {
      return { kind: "sent", ts: posted.ts };
    }
    return {
      error: describeFailure(posted),
      kind: posted.kind === "config" ? "next" : "failed",
    };
  };

  const send = async (postId: string): Promise<void> => {
    const [post] = await db
      .select()
      .from(inboxPosts)
      .where(eq(inboxPosts.id, postId))
      .limit(1);
    if (
      !post ||
      post.guestName !== null ||
      (await roomMessageOfPost(db, post.id))
    ) {
      return;
    }
    const room = await findOutboundRoom(db, {
      threadId: post.threadId,
      workspaceId: post.workspaceId,
    });
    const text = stripAttachmentMarkers(post.text).trim();
    if (!room || text === "") {
      return;
    }
    const name = await authorName(post);
    const root = await topicRootTs(db, {
      channelId: room.channelId,
      slackTeamId: room.slackTeamId,
      threadId: post.threadId,
    });
    let error = NO_APP;
    for (const sender of await sendersFor(post, room)) {
      // biome-ignore lint/performance/noAwaitInLoops: the next app is tried only when this one could not post
      const result = await sendThrough(sender, {
        channel: room.channelId,
        text: sender.own ? cutForSlack(text) : speakerLine(name, text),
        threadTs: root ?? undefined,
      });
      if (result.kind === "sent") {
        await recordOutMessage(db, {
          channelId: room.channelId,
          createdAt: clock.now().toISOString(),
          id: ulid(clock.now().getTime()),
          postId: post.id,
          slackTeamId: room.slackTeamId,
          threadTs: root,
          ts: result.ts,
          workspaceId: post.workspaceId,
        });
        return;
      }
      ({ error } = result);
      if (result.kind === "failed") {
        break;
      }
    }
    await reportRoomFailure(events, {
      agentId: post.authorKind === "agent" ? post.authorId : null,
      channelId: room.channelId,
      error,
      postId: post.id,
      slackTeamId: room.slackTeamId,
      teamId: room.teamId,
      threadId: post.threadId,
      workspaceId: post.workspaceId,
    });
  };

  /** The `events.onAppend` listener. A failure is logged, never thrown. */
  const onEvent = async (event: EventRecord): Promise<void> => {
    const { postId } = event.payload;
    if (event.type !== "inbox.posted" || typeof postId !== "string") {
      return;
    }
    const job = send(postId).catch((error: unknown) => {
      console.error("Slack room send failed", error);
    });
    if (defer) {
      defer(job);
      return;
    }
    await job;
  };

  return { onEvent };
};

export type RoomOutbound = ReturnType<typeof createRoomOutbound>;
