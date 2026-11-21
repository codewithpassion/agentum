/**
 * A message in a Slack channel that is linked to a team room. Every member
 * app of the team hears every message in the channel, so each app calls this
 * with its own copy of the event. The room records the message once: the
 * `slack_room_messages` row, which is unique per Slack message, rides in the
 * same atomic write as the post, and only the write that wins keeps its post.
 * The other copies are dropped.
 *
 * A Slack thread is a topic, found by its `thread_ts`. A top-level message
 * opens a topic titled from its first line. A person who is linked to an
 * Agentum account and is in the team posts as that person, and their post wakes
 * agents through the room (`@slug` for an app they mention, else the lead when
 * the team's `lead_listens` is on). A person with no link yet is matched by
 * their Slack email, as in a DM, and linked on a match, but only when they
 * belong to the app's own Slack team (a Slack Connect user's email is not
 * ours to trust). Anyone else posts as a named guest, and a guest's post wakes
 * nobody. A guest with no match is told once, privately in the thread, how to
 * get linked.
 *
 * Only the team's own apps feed its room: a copy is dropped unless the app
 * belongs to an active agent that is a member of the linked team (the lead is
 * always a member), by the same rule as `memberSenderApps`. A dropped copy
 * writes nothing and wakes nobody, and never falls through to the per-agent
 * path.
 *
 * What is left: the owner of a member agent still holds a signing secret that
 * can sign an event naming any Slack user, as on the per-agent path. That is
 * accepted as an assumption. A check against Slack, such as reading the
 * message back with `conversations.history` before a person's post wakes
 * anyone, would close it.
 */
import type { Database } from "@repo/db";
import { events as eventRows } from "@repo/db/schema/events";
import { slackRoomMessages } from "@repo/db/schema/slack";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { isUniqueViolation } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { isInTeam } from "../inbox/room-access.ts";
import type {
  ExternalPostInput,
  ExternalPostResult,
  InboxService,
} from "../inbox.ts";
import { type Clock, INPUT_TEXT_MAX } from "../runs/types.ts";
import {
  createSecretReader,
  type SecretReader,
  type SlackAppRow,
} from "./apps.ts";
import { createSlackClient, type SlackFetch } from "./client.ts";
import type { SlackEvent } from "./event-parse.ts";
import { withRetry } from "./post.ts";
import { memberSenderApps } from "./room-out-store.ts";
import {
  findRoomLink,
  findRoomTopic,
  isAppBotUser,
  roomAgentsByBotUser,
  roomMessageExists,
} from "./room-store.ts";
import {
  convertAgentMentions,
  guestName,
  slackMentionedUserIds,
  topicTitle,
} from "./room-text.ts";
import {
  HIDDEN_EMAIL_REPLY,
  type SenderMatch,
  UNLINKED_REPLY,
} from "./sender-match.ts";

type Message = Extract<SlackEvent, { kind: "message" }>;

/** What the events route does after the answer: wake the agents the message names. */
export interface RoomIntake {
  after?: () => Promise<void>;
  kind: "accepted";
}

const accepted: RoomIntake = { kind: "accepted" };

/** Why a Slack user is a guest, when there is something to tell them about it. */
type GuestReason = "hidden_email" | "no_account" | null;

/** The stored author id of a Slack user who has no Agentum account in the team. */
export const guestAuthorId = (slackTeamId: string, userId: string): string =>
  `slack:${slackTeamId}:${userId}`;

export const createRoomIntake = ({
  clock,
  db,
  events,
  fetch: slackFetch,
  findLink,
  inbox,
  matchSender,
  secretsKey,
}: {
  clock: Clock;
  db: Database;
  /** Remembers who was told how to get linked. */
  events: Pick<EventsService, "insertStatement">;
  fetch: SlackFetch;
  /** The Agentum account a Slack user is linked to in the app's Slack workspace. */
  findLink: (
    app: SlackAppRow,
    slackUserId: string
  ) => Promise<{ clerkUserId: string } | null>;
  inbox: Pick<InboxService, "postExternal">;
  /**
   * Matches a Slack user with no link to an Agentum account by their Slack
   * email, and writes the link on a match. Only for users of the app's own
   * Slack team.
   */
  matchSender: (app: SlackAppRow, slackUserId: string) => Promise<SenderMatch>;
  secretsKey?: string;
}) => {
  const secrets: SecretReader = createSecretReader(secretsKey);

  /** The name Slack shows for the user, or null when Slack will not say. */
  const slackName = async (
    app: SlackAppRow,
    userId: string
  ): Promise<string | null> => {
    try {
      const token = await secrets.botToken(app);
      if (!token) {
        return null;
      }
      const lookup = await createSlackClient({
        fetch: slackFetch,
        token,
      }).userName(userId);
      return lookup.kind === "ok" ? lookup.name : null;
    } catch (error) {
      console.error("Slack guest name lookup failed", error);
      return null;
    }
  };

  /**
   * The linked account of the Slack user: the one they already have, else the
   * one their Slack email matches. `reason` says why they have none, for the
   * guest to be told. Every member app runs this for its copy of a message,
   * and the link insert is a no-op for all but the first.
   */
  const accountOf = async (
    app: SlackAppRow,
    userId: string
  ): Promise<{ clerkUserId: string | null; reason: GuestReason }> => {
    const link = await findLink(app, userId);
    if (link) {
      return { clerkUserId: link.clerkUserId, reason: null };
    }
    const match = await matchSender(app, userId);
    if (match.kind === "linked") {
      return { clerkUserId: match.clerkUserId, reason: null };
    }
    return {
      clerkUserId: null,
      reason: match.kind === "none" ? match.reason : null,
    };
  };

  /**
   * The person the message is from: the linked account when it is in the
   * team, else a guest named after their Slack profile.
   */
  const author = async (
    app: SlackAppRow,
    message: Message,
    teamId: string
  ): Promise<
    | { id: string; person: true }
    | { id: string; name: string; person: false; reason: GuestReason }
  > => {
    const { clerkUserId, reason } = await accountOf(app, message.userId);
    if (
      clerkUserId &&
      (await isInTeam(db, teamId, { id: clerkUserId, kind: "user" }))
    ) {
      return { id: clerkUserId, person: true };
    }
    return {
      id: guestAuthorId(app.teamId, message.userId),
      name: (await slackName(app, message.userId)) ?? "",
      person: false,
      reason,
    };
  };

  /** True when a `slack.unlinked_sender` event already names this Slack user. */
  const wasTold = async (
    app: SlackAppRow,
    slackUserId: string
  ): Promise<boolean> => {
    const [told] = await db
      .select({ id: eventRows.id })
      .from(eventRows)
      .where(
        and(
          eq(eventRows.workspaceId, app.workspaceId),
          eq(eventRows.type, "slack.unlinked_sender"),
          sql`json_extract(${eventRows.payload}, '$.slackUserId') = ${slackUserId}`
        )
      )
      .limit(1);
    return told !== undefined;
  };

  /** The event that records a guest was told how to get linked, written with the post that tells them. */
  const toldStatement = (app: SlackAppRow, message: Message) =>
    events.insertStatement({
      actor: { id: "slack", kind: "system" },
      agentId: app.agentId,
      payload: {
        channel: message.channelId,
        slackUserId: message.userId,
        ts: message.ts,
      },
      type: "slack.unlinked_sender",
      workspaceId: app.workspaceId,
    });

  /** Tells a guest, in the thread and visible to them alone, how to get linked. */
  const tellGuest = async (
    app: SlackAppRow,
    message: Message,
    reason: Exclude<GuestReason, null>
  ) => {
    const token = await secrets.botToken(app);
    if (!token) {
      return;
    }
    const client = createSlackClient({ fetch: slackFetch, token });
    await withRetry(clock, () =>
      client.postEphemeral({
        channel: message.channelId,
        text: reason === "hidden_email" ? HIDDEN_EMAIL_REPLY : UNLINKED_REPLY,
        threadTs: message.threadTs ?? message.ts,
        user: message.userId,
      })
    );
  };

  const pairing = (
    app: SlackAppRow,
    message: Message,
    isReply: boolean,
    told: boolean
  ): ExternalPostInput["alongside"] => {
    const createdAt = clock.now().toISOString();
    return ({ postId }) => [
      ...(told ? [toldStatement(app, message)] : []),
      db.insert(slackRoomMessages).values({
        channelId: message.channelId,
        createdAt,
        direction: "in",
        id: ulid(clock.now().getTime()),
        postId,
        slackTeamId: app.teamId,
        threadTs: isReply ? (message.threadTs ?? null) : null,
        ts: message.ts,
        workspaceId: app.workspaceId,
      }),
    ];
  };

  /** True when this copy of the message adds nothing to the room. */
  const isDropped = async (
    app: SlackAppRow,
    message: Message
  ): Promise<boolean> => {
    // Another member app's own message, however Slack labels it. SL.3 recorded
    // it when it sent it.
    const fromMemberApp = await isAppBotUser(db, {
      slackTeamId: app.teamId,
      userId: message.userId,
      workspaceId: app.workspaceId,
    });
    return (
      fromMemberApp ||
      message.text.trim() === "" ||
      (await roomMessageExists(db, {
        channelId: message.channelId,
        slackTeamId: app.teamId,
        ts: message.ts,
      }))
    );
  };

  /** True when the app belongs to an active agent on the team. */
  const isTeamApp = async (
    app: SlackAppRow,
    teamId: string
  ): Promise<boolean> => {
    const senders = await memberSenderApps(db, {
      slackTeamId: app.teamId,
      teamId,
      workspaceId: app.workspaceId,
    });
    return senders.some((sender) => sender.app.id === app.id);
  };

  /** The topic the message goes in: the one its Slack thread belongs to, else a new one. */
  const topicFor = async (
    app: SlackAppRow,
    message: Message,
    teamId: string,
    isReply: boolean,
    text: string
  ): Promise<ExternalPostInput["thread"]> => {
    const topicId =
      isReply && message.threadTs !== undefined
        ? await findRoomTopic(db, {
            channelId: message.channelId,
            slackTeamId: app.teamId,
            teamId,
            threadTs: message.threadTs,
          })
        : null;
    return topicId
      ? { id: topicId, kind: "existing" }
      : { kind: "new", title: topicTitle(text) };
  };

  const record = async (
    app: SlackAppRow,
    message: Message,
    teamId: string
  ): Promise<ExternalPostResult & { guestReason: GuestReason }> => {
    const roomAgents = await roomAgentsByBotUser(db, {
      botUserIds: slackMentionedUserIds(message.text),
      slackTeamId: app.teamId,
      teamId,
      workspaceId: app.workspaceId,
    });
    const text = convertAgentMentions(message.text, roomAgents)
      .trim()
      .slice(0, INPUT_TEXT_MAX);
    const isReply =
      message.threadTs !== undefined && message.threadTs !== message.ts;
    const from = await author(app, message, teamId);
    // A guest is told once, ever: the event that says so rides in the write of
    // the post that wins, so no later message finds them untold.
    const guestReason =
      !from.person &&
      from.reason !== null &&
      !(await wasTold(app, message.userId))
        ? from.reason
        : null;
    const posted = await inbox.postExternal({
      alongside: pairing(app, message, isReply, guestReason !== null),
      authorId: from.id,
      ...(from.person ? {} : { guestName: guestName(from.name) }),
      teamId,
      text,
      thread: await topicFor(app, message, teamId, isReply, text),
      waker: from.person
        ? {
            kind: "user",
            userId: from.id,
            via: "slack",
            workspaceId: app.workspaceId,
          }
        : null,
      workspaceId: app.workspaceId,
    });
    return { ...posted, guestReason };
  };

  /**
   * Handles one copy of a channel message. Returns null when the channel is
   * not linked to a team room, and the caller carries on as it always did.
   */
  const receive = async (
    app: SlackAppRow,
    message: Message
  ): Promise<RoomIntake | null> => {
    const link = await findRoomLink(db, {
      channelId: message.channelId,
      slackTeamId: app.teamId,
      workspaceId: app.workspaceId,
    });
    if (!link) {
      return null;
    }
    if (
      !(await isTeamApp(app, link.teamId)) ||
      (await isDropped(app, message))
    ) {
      return accepted;
    }
    try {
      const posted = await record(app, message, link.teamId);
      return {
        after: async () => {
          try {
            await posted.wake();
          } catch (error) {
            console.error("Slack room wake failed", error);
          }
          if (posted.guestReason) {
            try {
              await tellGuest(app, message, posted.guestReason);
            } catch (error) {
              console.error("Slack guest reply failed", error);
            }
          }
        },
        kind: "accepted",
      };
    } catch (error) {
      // Another app's copy of this message won the key while this one was
      // being written. Its write kept the post, so this one is dropped.
      const lost =
        isUniqueViolation(error) &&
        (await roomMessageExists(db, {
          channelId: message.channelId,
          slackTeamId: app.teamId,
          ts: message.ts,
        }));
      if (lost) {
        return accepted;
      }
      throw error;
    }
  };

  return { receive };
};

export type RoomIntakeService = ReturnType<typeof createRoomIntake>;
