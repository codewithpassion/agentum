import { describe, expect, test } from "bun:test";
import type {
  CreateMessageInput,
  MessageView,
} from "#/modules/messaging/service";
import type { BridgeAdapter, ExternalRefInput, InboundMessage } from "../types";
import type { SlackEventCallback } from "./events";
import { ingestSlackEvent, type SlackIngestPorts } from "./ingest";

const SLACK_CHANNEL = "C0OPSCHAN";

const delivery = (eventId: string): SlackEventCallback => ({
  authorizations: [{ user_id: "U0BOTAGENT" }],
  event: {
    channel: SLACK_CHANNEL,
    text: "hello team",
    ts: "1787200000.000100",
    type: "message",
    user: "U1ALICE",
  },
  event_id: eventId,
  type: "event_callback",
});

const publishedMessage = (input: CreateMessageInput): MessageView => ({
  attachments: [],
  author: null,
  authorId: input.authorId,
  authorType: input.authorType,
  body: input.body,
  channelId: input.channelId,
  createdAt: 0,
  id: "message-1",
  mentions: [],
  origin: input.origin ?? "native",
  replyCount: 0,
  threadParentId: input.threadParentId ?? null,
});

const adapter = (
  inbound: InboundMessage | null,
  normalized: SlackEventCallback[]
): BridgeAdapter<SlackEventCallback> => ({
  connector: "slack",
  label: "Slack",
  mirrorOutbound: () => Promise.resolve(null),
  normalizeInbound: (event) => {
    normalized.push(event);
    return Promise.resolve(inbound);
  },
});

const inboundFor = (): InboundMessage => ({
  externalId: `${SLACK_CHANNEL}:1787200000.000100`,
  input: {
    authorId: "slack:U1ALICE",
    authorType: "external",
    body: "hello team",
    channelId: "channel-1",
    origin: "slack",
    workspace: { id: "ws_default", slug: "default" },
  },
});

const ports = (
  options: { publishOk?: boolean } = {}
): SlackIngestPorts & {
  claimed: Set<string>;
  published: CreateMessageInput[];
  refs: ExternalRefInput[];
} => {
  const claimed = new Set<string>();
  const published: CreateMessageInput[] = [];
  const refs: ExternalRefInput[] = [];

  return {
    // The real implementation is an INSERT … ON CONFLICT DO NOTHING; a Set has
    // the same "first caller wins" contract.
    claimEvent: (eventId) => {
      if (claimed.has(eventId)) {
        return Promise.resolve(false);
      }
      claimed.add(eventId);
      return Promise.resolve(true);
    },
    claimed,
    publish: (input) => {
      published.push(input);
      return Promise.resolve(
        options.publishOk === false
          ? {
              ok: false as const,
              reason: "The thread parent is not in this channel.",
            }
          : { message: publishedMessage(input), ok: true as const }
      );
    },
    published,
    recordMessageRef: (ref) => {
      refs.push(ref);
      return Promise.resolve();
    },
    refs,
  };
};

describe("ingestSlackEvent", () => {
  test("publishes an event and remembers which Slack message it was", async () => {
    const normalized: SlackEventCallback[] = [];
    const slackPorts = ports();

    const outcome = await ingestSlackEvent(
      delivery("Ev0001"),
      adapter(inboundFor(), normalized),
      slackPorts
    );

    expect(outcome).toBe("published");
    expect(slackPorts.published).toHaveLength(1);
    expect(slackPorts.published[0]?.origin).toBe("slack");
    expect(slackPorts.refs).toEqual([
      {
        externalId: `${SLACK_CHANNEL}:1787200000.000100`,
        internalId: "message-1",
        internalType: "message",
      },
    ]);
  });

  test("processes a retried event id exactly once", async () => {
    const normalized: SlackEventCallback[] = [];
    const slackPorts = ports();
    const connector = adapter(inboundFor(), normalized);

    const first = await ingestSlackEvent(
      delivery("Ev0001"),
      connector,
      slackPorts
    );
    // Slack retries a delivery it believes failed; the claim is what stops it.
    const second = await ingestSlackEvent(
      delivery("Ev0001"),
      connector,
      slackPorts
    );

    expect([first, second]).toEqual(["published", "duplicate"]);
    expect(normalized).toHaveLength(1);
    expect(slackPorts.published).toHaveLength(1);
  });

  test("stops after normalisation when there is nothing to publish", async () => {
    const slackPorts = ports();

    const outcome = await ingestSlackEvent(
      delivery("Ev0002"),
      adapter(null, []),
      slackPorts
    );

    expect(outcome).toBe("ignored");
    expect(slackPorts.published).toEqual([]);
    expect(slackPorts.refs).toEqual([]);
  });

  test("records no mapping when the message could not be stored", async () => {
    const slackPorts = ports({ publishOk: false });

    const outcome = await ingestSlackEvent(
      delivery("Ev0003"),
      adapter(inboundFor(), []),
      slackPorts
    );

    expect(outcome).toBe("rejected");
    expect(slackPorts.refs).toEqual([]);
  });
});
