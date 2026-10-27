/**
 * `slack_send` and `slack_destinations`: an agent starts a message in a
 * channel its bot is in, or in a DM with a person who linked their Slack
 * account. Every send is capped per agent per hour, written to the event log
 * without its text, and, when it starts a thread, remembered so replies in it
 * route back to the run's session. A reply may also go into a thread whose
 * messages were stored from Slack, or that Slack confirms in the channel.
 * An `@name` in the text becomes a Slack mention when exactly one linked person has that name.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { slackMessages, slackThreads } from "@repo/db/schema/slack";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import type { SlackAppRow } from "./slack/apps.ts";
import type { SlackClient, SlackFetch } from "./slack/client.ts";
import {
  channelMention,
  convertMentions,
  userMention,
} from "./slack/mentions.ts";
import { linkedPeople } from "./slack/people.ts";
import { withRetry } from "./slack/post.ts";
import {
  createAgentClients,
  type RunPrincipal,
  requireRun,
  slackFailure,
} from "./slack/run-app.ts";
import { startedThreadStatement } from "./slack/threads.ts";
import type { Principal } from "./workspaces.ts";

export interface SlackSendOptions {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  fetch: SlackFetch;
  outbound?: (
    principal: Principal,
    key: string,
    input: unknown
  ) => Promise<void>;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}

export interface SendInput {
  text: string;
  threadTs?: string;
  to: string;
}

const SENT_EVENT = "slack.message_sent";
const SEND_ACTION = "slack.send";
const SENDS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const TEXT_MAX = 4000;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
const LEADING_SIGIL = /^[#@]/;

const TOOL_NAMES = "slack_send and slack_destinations";
const THREAD_REFUSAL =
  "thread_ts must be the ts of a message in this same channel or DM, such as one that slack_history, slack_search or a batch of channel messages showed.";

export const createSlackSendService = ({
  atomic,
  clock,
  db,
  events,
  fetch: slackFetch,
  secretsKey,
  outbound,
}: SlackSendOptions) => {
  const agentClient = createAgentClients({
    db,
    fetch: slackFetch,
    secretsKey,
  });
  const requireSendRun = (principal: Principal): RunPrincipal =>
    requireRun(principal, SEND_ACTION, TOOL_NAMES);

  const channelsOf = async (client: SlackClient) => {
    const result = await client.listChannels();
    if (result.kind !== "ok") {
      throw slackFailure(result);
    }
    return result.channels;
  };

  const openDmWith = async (
    client: SlackClient,
    externalUserId: string
  ): Promise<string> => {
    const opened = await client.openDm(externalUserId);
    if (opened.kind !== "ok") {
      throw slackFailure(opened);
    }
    return opened.channelId;
  };

  const destinations = async (principal: Principal) => {
    const run = requireSendRun(principal);
    const { app, client } = await agentClient(run);
    const [channels, people] = await Promise.all([
      channelsOf(client),
      linkedPeople(db, client, app),
    ]);
    return {
      channels: channels.map(({ id, isPrivate, name }) => ({
        id,
        isPrivate,
        mention: channelMention(id),
        name,
      })),
      people: people.map(({ email, externalUserId, slackName }) => ({
        email,
        mention: userMention(externalUserId),
        slackName,
        slackUserId: externalUserId,
      })),
    };
  };

  /** A channel the bot is in, or a linked person. Channels win over people. */
  const resolveTarget = async (
    client: SlackClient,
    app: SlackAppRow,
    to: string
  ): Promise<
    | { channelId: string; kind: "channel"; name: string; to: string }
    | { email: string; externalUserId: string; kind: "person"; to: string }
  > => {
    const bare = to.replace(LEADING_SIGIL, "");
    const lower = bare.toLowerCase();
    const channel = (await channelsOf(client)).find(
      (candidate) =>
        candidate.id === bare || candidate.name.toLowerCase() === lower
    );
    if (channel) {
      return {
        channelId: channel.id,
        kind: "channel",
        name: channel.name,
        to: `#${channel.name}`,
      };
    }

    const matches = (await linkedPeople(db, client, app)).filter(
      (entry) =>
        entry.email.toLowerCase() === lower ||
        entry.slackName.toLowerCase() === lower
    );
    const [person, ...others] = matches;
    if (person && others.length > 0) {
      throw new ServiceError(
        "invalid",
        `"${to}" matches more than one person, use their email.`
      );
    }
    if (person) {
      return {
        email: person.email,
        externalUserId: person.externalUserId,
        kind: "person",
        to: person.email,
      };
    }

    if (to.startsWith("#") || CHANNEL_ID.test(bare)) {
      throw new ServiceError(
        "not_found",
        `The bot is not in "${to}". Ask a person to add it with /invite in that channel, or pick one from slack_destinations.`
      );
    }
    throw new ServiceError(
      "not_found",
      `"${to}" is not a channel the bot is in or a linked person. Only people who linked their Slack account to Harbourmaster can be messaged, so ask them to message this agent in Slack once. Call slack_destinations to see the targets.`
    );
  };

  /** Refuses the send when the agent already sent the limit within the last hour. */
  const checkRate = async (run: RunPrincipal, now: Date): Promise<void> => {
    const since = new Date(now.getTime() - HOUR_MS).toISOString();
    const sent = await db
      .select({ createdAt: eventRows.createdAt })
      .from(eventRows)
      .where(
        and(
          eq(eventRows.workspaceId, run.workspaceId),
          eq(eventRows.agentId, run.agentId),
          eq(eventRows.type, SENT_EVENT),
          gt(eventRows.createdAt, since)
        )
      )
      .orderBy(asc(eventRows.createdAt));
    const blocking = sent.at(-SENDS_PER_HOUR);
    if (blocking) {
      const next = new Date(
        Date.parse(blocking.createdAt) + HOUR_MS
      ).toISOString();
      throw new ServiceError(
        "conflict",
        `The agent sent ${SENDS_PER_HOUR} Slack messages in the last hour, which is the limit. The next send is allowed at ${next}.`
      );
    }
  };

  /**
   * True for a thread the agent started, or one with a stored message of this
   * app in this channel: the parent (`ts`) or a reply (`thread_ts`). Failing
   * both, Slack is asked whether the message exists in this channel, so a ts
   * that only `slack_history` showed works too.
   */
  const threadIsKnown = async (
    client: SlackClient,
    run: RunPrincipal,
    app: SlackAppRow,
    channelId: string,
    threadTs: string
  ): Promise<boolean> => {
    const [started] = await db
      .select({ id: slackThreads.id })
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.workspaceId, run.workspaceId),
          eq(slackThreads.agentId, run.agentId),
          eq(slackThreads.teamId, app.teamId),
          eq(slackThreads.channelId, channelId),
          eq(slackThreads.threadTs, threadTs)
        )
      )
      .limit(1);
    if (started) {
      return true;
    }
    const [stored] = await db
      .select({ id: slackMessages.id })
      .from(slackMessages)
      .where(
        and(
          eq(slackMessages.appId, app.id),
          eq(slackMessages.channelId, channelId),
          or(
            eq(slackMessages.ts, threadTs),
            eq(slackMessages.threadTs, threadTs)
          )
        )
      )
      .limit(1);
    if (stored) {
      return true;
    }
    const live = await client.replies({
      channel: channelId,
      limit: 1,
      ts: threadTs,
    });
    if (live.kind === "ok") {
      return live.messages.length > 0;
    }
    if (live.kind === "rejected") {
      return false;
    }
    throw slackFailure(live);
  };

  /** Writes the thread (when new) and the send event in one atomic write. */
  const record = async (
    run: RunPrincipal,
    app: SlackAppRow,
    sent: {
      channelId: string;
      detail: { channelName: string } | { person: string };
      textLength: number;
      threadTs?: string;
      ts: string;
    }
  ): Promise<void> => {
    const [runRow] = await db
      .select({ sessionId: runs.sessionId })
      .from(runs)
      .where(and(eq(runs.id, run.runId), eq(runs.workspaceId, run.workspaceId)))
      .limit(1);
    const sessionId = runRow?.sessionId ?? null;
    const statements: Statement[] = [];
    if (sent.threadTs === undefined && sessionId !== null) {
      statements.push(
        startedThreadStatement(db, {
          agentId: run.agentId,
          channelId: sent.channelId,
          createdAt: clock.now().toISOString(),
          sessionId,
          teamId: app.teamId,
          threadTs: sent.ts,
          workspaceId: run.workspaceId,
        })
      );
    }
    statements.push(
      events.insertStatement({
        actor: { id: run.agentId, kind: "agent" },
        agentId: run.agentId,
        payload: {
          channel: sent.channelId,
          ...sent.detail,
          textLength: sent.textLength,
          ...(sent.threadTs === undefined ? {} : { threadTs: sent.threadTs }),
          ts: sent.ts,
        },
        runId: run.runId,
        sessionId,
        type: SENT_EVENT,
        workspaceId: run.workspaceId,
      })
    );
    await atomic(statements);
  };

  const approveSend = async (
    principal: Principal,
    run: RunPrincipal,
    input: unknown
  ) => {
    if (!outbound) {
      const [room] = await db
        .select({ origin: sessions.origin })
        .from(runs)
        .innerJoin(sessions, eq(sessions.id, runs.sessionId))
        .where(
          and(eq(runs.id, run.runId), eq(runs.workspaceId, run.workspaceId))
        )
        .limit(1);
      if (room?.origin === "artifact") {
        throw new ForbiddenError("slack.outboundUnavailable");
      }
    }
    await outbound?.(principal, "harbourmaster/slack_send", input);
  };
  const send = async (
    principal: Principal,
    input: SendInput
  ): Promise<{
    channel: string;
    notes: string[];
    permalink: string | null;
    to: string;
    ts: string;
  }> => {
    const run = requireSendRun(principal);
    const { app, client } = await agentClient(run);

    const text = input.text.trim();
    if (text.length < 1 || text.length > TEXT_MAX) {
      throw new ServiceError(
        "invalid",
        `The message must be 1 to ${TEXT_MAX} characters.`
      );
    }
    await checkRate(run, clock.now());

    const target = await resolveTarget(client, app, input.to);
    const channelId =
      target.kind === "channel"
        ? target.channelId
        : await openDmWith(client, target.externalUserId);

    if (
      input.threadTs !== undefined &&
      !(await threadIsKnown(client, run, app, channelId, input.threadTs))
    ) {
      throw new ServiceError("invalid", THREAD_REFUSAL);
    }

    const { notes, text: postedText } = text.includes("@")
      ? convertMentions(text, await linkedPeople(db, client, app))
      : { notes: [], text };

    await approveSend(principal, run, {
      channel: channelId,
      text: postedText,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    });
    const posted = await withRetry(clock, () =>
      client.postMessage({
        channel: channelId,
        text: postedText,
        threadTs: input.threadTs,
      })
    );
    if (posted.kind !== "ok") {
      throw slackFailure(posted);
    }

    const link = await client.permalink(channelId, posted.ts);
    const permalink = link.kind === "ok" ? link.permalink : null;

    try {
      await record(run, app, {
        channelId,
        detail:
          target.kind === "channel"
            ? { channelName: target.name }
            : { person: target.email },
        textLength: postedText.length,
        threadTs: input.threadTs,
        ts: posted.ts,
      });
    } catch (error) {
      // The message is already in Slack, so the caller still gets the result.
      console.error("Recording a Slack send failed", error);
    }

    return {
      channel: channelId,
      notes,
      permalink,
      to: target.to,
      ts: posted.ts,
    };
  };

  return { destinations, send };
};

export type SlackSendService = ReturnType<typeof createSlackSendService>;
