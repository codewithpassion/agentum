/**
 * A fake Slack for tests and for local walkthroughs. It answers the Web API
 * methods the app calls (`fetch`), keeps the channels and their messages, and
 * delivers signed events and button clicks to the member apps the way Slack
 * does: every app whose bot sits in a channel hears every message in it,
 * including the messages of the other apps.
 *
 * It holds no Agentum code. A caller gives it a `deliver` function that carries
 * a signed request to the app's events or interactions route, in process in a
 * test and over HTTP in `scripts/dev/fake-slack.ts`.
 */
import { signSlackBody } from "./signature.ts";

export interface FakeSlackApp {
  appId: string;
  /** Slack's id for the bot behind the app, `B...`. */
  botId: string;
  botUserId: string;
  name: string;
  signingSecret: string;
  token: string;
}

export interface FakeSlackUser {
  email: string | null;
  id: string;
  name: string;
}

export interface FakeSlackChannel {
  id: string;
  isPrivate: boolean;
  /** User ids and bot user ids that are in the channel. */
  members: string[];
  name: string;
}

export interface FakeSlackConfig {
  apps: FakeSlackApp[];
  channels: FakeSlackChannel[];
  slackTeamId: string;
  users: FakeSlackUser[];
}

export interface FakeMessage {
  /** The app that posted it, or null for a person. */
  appId: string | null;
  blocks: unknown[] | null;
  channel: string;
  text: string;
  threadTs: string | null;
  ts: string;
  /** The user id, or the bot user id for an app's message. */
  user: string;
}

/** A signed request for the app to receive. */
export interface Delivery {
  appId: string;
  /** `events` carries JSON, `interactions` a form body with a `payload` field. */
  kind: "events" | "interactions";
  rawBody: string;
  signature: string;
  timestamp: string;
}

/** One Web API call the fake answered. */
export interface FakeCall {
  appId: string | null;
  body: Record<string, unknown>;
  method: string;
}

export interface FakeSlackOptions {
  config: FakeSlackConfig;
  /** Carries a delivery to the app. Without it, deliveries are only counted. */
  deliver?: (delivery: Delivery) => Promise<void>;
  /** Milliseconds since the epoch. Defaults to the clock. */
  now?: () => number;
}

type Reply = Record<string, unknown>;

interface Call {
  app: FakeSlackApp;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

const MS_PER_SECOND = 1000;
const TS_DIGITS = 6;
const DEFAULT_LIMIT = 100;
const MENTION = /<@([UW][A-Z0-9]+)>/g;
const API_PREFIX = "/api/";
const BEARER = /^Bearer\s+/;

const failure = (error: string): Reply => ({ error, ok: false });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const createFakeSlack = ({
  config,
  deliver,
  now = () => Date.now(),
}: FakeSlackOptions) => {
  const messages: FakeMessage[] = [];
  const calls: FakeCall[] = [];
  const ephemerals: { channel: string; text: string; user: string }[] = [];
  const deliveryErrors: string[] = [];
  const pending = new Set<Promise<void>>();
  let sequence = 0;
  let eventCount = 0;

  const appOfToken = (token: string): FakeSlackApp | undefined =>
    config.apps.find((app) => app.token === token);
  const channelOf = (id: string): FakeSlackChannel | undefined =>
    config.channels.find((channel) => channel.id === id);

  /** Seconds, a dot and six digits, strictly increasing so every ts is unique. */
  const nextTs = (): string => {
    sequence += 1;
    const seconds = Math.floor(now() / MS_PER_SECOND);
    return `${seconds}.${String(sequence).padStart(TS_DIGITS, "0")}`;
  };

  /** Signs a delivery, hands it to `deliver`, and counts it as pending until it is done. */
  const send = (delivery: Promise<Delivery>): void => {
    if (!deliver) {
      return;
    }
    const job = delivery
      .then(deliver)
      .catch((error: unknown) => {
        deliveryErrors.push(
          error instanceof Error ? error.message : "delivery failed"
        );
      })
      .finally(() => {
        pending.delete(job);
      });
    pending.add(job);
  };

  const signed = async (
    app: FakeSlackApp,
    kind: Delivery["kind"],
    rawBody: string
  ): Promise<Delivery> => {
    const timestamp = String(Math.floor(now() / MS_PER_SECOND));
    return {
      appId: app.appId,
      kind,
      rawBody,
      signature: await signSlackBody({
        body: rawBody,
        signingSecret: app.signingSecret,
        timestamp,
      }),
      timestamp,
    };
  };

  const eventBody = (
    app: FakeSlackApp,
    event: Record<string, unknown>
  ): string => {
    eventCount += 1;
    return JSON.stringify({
      api_app_id: app.appId,
      event,
      event_id: `Ev0FAKE${String(eventCount).padStart(TS_DIGITS, "0")}`,
      event_time: Math.floor(now() / MS_PER_SECOND),
      team_id: config.slackTeamId,
      type: "event_callback",
    });
  };

  const mentionedUsers = (text: string): string[] =>
    [...text.matchAll(MENTION)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    );

  /** The events one app hears for a message: the message, and a mention when it is named. */
  const eventsFor = (
    app: FakeSlackApp,
    channel: FakeSlackChannel,
    message: FakeMessage,
    poster: FakeSlackApp | undefined
  ): Record<string, unknown>[] => {
    const base: Record<string, unknown> = {
      channel: message.channel,
      text: message.text,
      ts: message.ts,
      user: message.user,
      ...(message.threadTs === null ? {} : { thread_ts: message.threadTs }),
      ...(poster ? { app_id: poster.appId, bot_id: poster.botId } : {}),
    };
    const heard = {
      ...base,
      channel_type: channel.isPrivate ? "group" : "channel",
      type: "message",
    };
    const named =
      !poster && mentionedUsers(message.text).includes(app.botUserId);
    return named ? [heard, { ...base, type: "app_mention" }] : [heard];
  };

  /** What each app in the channel hears when `message` is posted. */
  const announce = (message: FakeMessage): void => {
    const channel = channelOf(message.channel);
    if (!channel) {
      return;
    }
    const poster = message.appId
      ? config.apps.find((app) => app.appId === message.appId)
      : undefined;
    const listeners = config.apps.filter((app) =>
      channel.members.includes(app.botUserId)
    );
    for (const app of listeners) {
      for (const event of eventsFor(app, channel, message, poster)) {
        send(signed(app, "events", eventBody(app, event)));
      }
    }
  };

  const store = (message: Omit<FakeMessage, "ts">): FakeMessage => {
    const stored = { ...message, ts: nextTs() };
    messages.push(stored);
    announce(stored);
    return stored;
  };

  const historyEntry = (message: FakeMessage): Reply => {
    const poster = message.appId
      ? config.apps.find((app) => app.appId === message.appId)
      : undefined;
    return {
      ...(poster ? { bot_id: poster.botId } : {}),
      text: message.text,
      ...(message.threadTs === null ? {} : { thread_ts: message.threadTs }),
      ts: message.ts,
      user: message.user,
    };
  };

  const windowOf = (query: URLSearchParams) => {
    const oldest = Number(query.get("oldest") ?? 0);
    const latest = Number(query.get("latest") ?? Number.POSITIVE_INFINITY);
    const limit = Number(query.get("limit") ?? DEFAULT_LIMIT);
    return { latest, limit, oldest };
  };

  const inChannel = (
    app: FakeSlackApp,
    id: string
  ): FakeSlackChannel | null => {
    const channel = channelOf(id);
    if (!channel) {
      return null;
    }
    return channel.members.includes(app.botUserId) ? channel : null;
  };

  const userInfo = (id: string): Reply => {
    const user = config.users.find((candidate) => candidate.id === id);
    if (!user) {
      return failure("user_not_found");
    }
    return {
      ok: true,
      user: {
        id: user.id,
        name: user.name.toLowerCase().replaceAll(" ", "."),
        profile: {
          display_name: user.name,
          real_name: user.name,
          ...(user.email === null ? {} : { email: user.email }),
        },
        real_name: user.name,
      },
    };
  };

  const postMessage = ({ app, body }: Call): Reply => {
    const channelId = textOf(body.channel);
    if (!channelOf(channelId)) {
      return failure("channel_not_found");
    }
    if (!inChannel(app, channelId)) {
      return failure("not_in_channel");
    }
    const stored = store({
      appId: app.appId,
      blocks: Array.isArray(body.blocks) ? body.blocks : null,
      channel: channelId,
      text: textOf(body.text),
      threadTs: textOf(body.thread_ts) || null,
      user: app.botUserId,
    });
    return { channel: channelId, ok: true, ts: stored.ts };
  };

  const updateMessage = ({ app, body }: Call): Reply => {
    const target = messages.find(
      (message) =>
        message.channel === textOf(body.channel) &&
        message.ts === textOf(body.ts) &&
        message.appId === app.appId
    );
    if (!target) {
      return failure("message_not_found");
    }
    target.text = textOf(body.text);
    target.blocks = Array.isArray(body.blocks) ? body.blocks : null;
    return { ok: true, ts: target.ts };
  };

  const history = ({ app, query }: Call): Reply => {
    const channelId = query.get("channel") ?? "";
    if (!inChannel(app, channelId)) {
      return failure("not_in_channel");
    }
    const { latest, limit, oldest } = windowOf(query);
    const page = messages
      .filter(
        (message) =>
          message.channel === channelId &&
          (message.threadTs === null || message.threadTs === message.ts) &&
          Number(message.ts) >= oldest &&
          Number(message.ts) <= latest
      )
      .reverse()
      .slice(0, limit);
    return {
      messages: page.map(historyEntry),
      ok: true,
      response_metadata: { next_cursor: "" },
    };
  };

  const replies = ({ app, query }: Call): Reply => {
    const channelId = query.get("channel") ?? "";
    if (!inChannel(app, channelId)) {
      return failure("not_in_channel");
    }
    const root = query.get("ts") ?? "";
    const thread = messages.filter(
      (message) =>
        message.channel === channelId &&
        (message.ts === root || message.threadTs === root)
    );
    return {
      messages: thread.map(historyEntry),
      ok: true,
      response_metadata: { next_cursor: "" },
    };
  };

  const channelInfo = ({ app, query }: Call): Reply => {
    const channel = channelOf(query.get("channel") ?? "");
    if (!channel || (channel.isPrivate && !inChannel(app, channel.id))) {
      return failure("channel_not_found");
    }
    return {
      channel: {
        id: channel.id,
        is_member: channel.members.includes(app.botUserId),
        name: channel.name,
      },
      ok: true,
    };
  };

  /** The channels the bot is in; with `user`, only those that user is in too. */
  const botChannels = ({ app, query }: Call): Reply => {
    const user = query.get("user") ?? "";
    return {
      channels: config.channels
        .filter(
          (channel) =>
            channel.members.includes(app.botUserId) &&
            (user === "" || channel.members.includes(user))
        )
        .map((channel) => ({
          id: channel.id,
          is_private: channel.isPrivate,
          name: channel.name,
        })),
      ok: true,
      response_metadata: { next_cursor: "" },
    };
  };

  const handlers: Record<string, (call: Call) => Reply> = {
    "assistant.threads.setStatus": () => ({ ok: true }),
    "auth.test": ({ app }) => ({
      bot_id: app.botId,
      ok: true,
      team_id: config.slackTeamId,
      user_id: app.botUserId,
    }),
    "bots.info": ({ app, query }) =>
      query.get("bot") === app.botId
        ? { bot: { app_id: app.appId, id: app.botId }, ok: true }
        : failure("bot_not_found"),
    "chat.getPermalink": ({ query }) => ({
      ok: true,
      permalink: `https://fake.slack.test/archives/${query.get("channel")}/p${query.get("message_ts")}`,
    }),
    "chat.postEphemeral": ({ body }) => {
      ephemerals.push({
        channel: textOf(body.channel),
        text: textOf(body.text),
        user: textOf(body.user),
      });
      return { message_ts: nextTs(), ok: true };
    },
    "chat.postMessage": postMessage,
    "chat.update": updateMessage,
    "conversations.history": history,
    "conversations.info": channelInfo,
    "conversations.open": ({ body }) => ({
      channel: { id: `D0${textOf(body.users)}` },
      ok: true,
    }),
    "conversations.replies": replies,
    "users.conversations": botChannels,
    "users.info": ({ query }) => userInfo(query.get("user") ?? ""),
    "views.open": () => ({ ok: true }),
  };

  /** The Slack Web API: the `fetch` the app's Slack client is given. */
  const fetchSlack = (
    url: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const parsed = new URL(url instanceof Request ? url.url : url);
    if (!parsed.pathname.startsWith(API_PREFIX)) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const headers = new Headers(init.headers);
    const app = appOfToken(
      (headers.get("Authorization") ?? "").replace(BEARER, "")
    );
    if (!app) {
      return Promise.resolve(Response.json(failure("invalid_auth")));
    }
    const method = parsed.pathname.slice(API_PREFIX.length);
    let body: Record<string, unknown> = {};
    if (typeof init.body === "string") {
      const parsedBody: unknown = JSON.parse(init.body);
      body = isRecord(parsedBody) ? parsedBody : {};
    }
    calls.push({ appId: app.appId, body, method });
    const handler = handlers[method];
    return Promise.resolve(
      Response.json(
        handler
          ? handler({ app, body, query: parsed.searchParams })
          : failure("unknown_method")
      )
    );
  };

  /** A person writes in a channel. Every app in the channel hears it. */
  const say = (input: {
    channel: string;
    text: string;
    threadTs?: string;
    user: string;
  }): FakeMessage => {
    if (!channelOf(input.channel)) {
      throw new Error(`No channel ${input.channel}.`);
    }
    return store({
      appId: null,
      blocks: null,
      channel: input.channel,
      text: input.text,
      threadTs: input.threadTs ?? null,
      user: input.user,
    });
  };

  /** A person presses a button on a message an app posted. */
  const click = (input: {
    actionId: string;
    channel: string;
    ts: string;
    user: string;
  }): void => {
    const target = messages.find(
      (message) => message.channel === input.channel && message.ts === input.ts
    );
    const app = config.apps.find(
      (candidate) => candidate.appId === target?.appId
    );
    if (!(target && app)) {
      throw new Error("That message was not posted by an app.");
    }
    const payload = {
      actions: [{ action_id: input.actionId, type: "button" }],
      api_app_id: app.appId,
      channel: { id: input.channel },
      container: {
        channel_id: input.channel,
        thread_ts: target.threadTs ?? target.ts,
      },
      message: { thread_ts: target.threadTs ?? target.ts, ts: target.ts },
      team: { id: config.slackTeamId },
      trigger_id: `fake-trigger-${nextTs()}`,
      type: "block_actions",
      user: { id: input.user },
    };
    send(
      signed(
        app,
        "interactions",
        `payload=${encodeURIComponent(JSON.stringify(payload))}`
      )
    );
  };

  /** Resolves when every delivery started so far, and any it caused, has finished. */
  const settled = async (): Promise<void> => {
    // A delivery can make an app post, which starts more deliveries.
    await Promise.resolve();
    if (pending.size === 0) {
      return;
    }
    await Promise.all([...pending]);
    await settled();
  };

  return {
    calls,
    click,
    config,
    deliveryErrors,
    ephemerals,
    fetch: fetchSlack,
    messages,
    say,
    settled,
  };
};

export type FakeSlack = ReturnType<typeof createFakeSlack>;
