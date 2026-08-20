import { describe, expect, test } from "bun:test";
import {
  isSlackChannelId,
  parseSlackEnvelope,
  slackMessageKey,
  slackMessageTs,
} from "./events";

describe("parseSlackEnvelope", () => {
  test("accepts the handshake and an event delivery", () => {
    expect(
      parseSlackEnvelope({ challenge: "abc", type: "url_verification" })
    ).toEqual({ challenge: "abc", type: "url_verification" });

    const delivery = parseSlackEnvelope({
      event: { channel: "C0OPSCHAN", ts: "1.1", type: "message", user: "U1" },
      event_id: "Ev1",
      type: "event_callback",
    });
    expect(delivery?.type).toBe("event_callback");
  });

  test("rejects payloads we would otherwise have to guess at", () => {
    expect(parseSlackEnvelope({ type: "app_rate_limited" })).toBeNull();
    expect(
      parseSlackEnvelope({ event: {}, type: "event_callback" })
    ).toBeNull();
    expect(parseSlackEnvelope("not an object")).toBeNull();
  });
});

describe("isSlackChannelId", () => {
  test("accepts channel, group and IM ids", () => {
    expect(isSlackChannelId("C0123ABCDEF")).toBe(true);
    expect(isSlackChannelId("G0123ABCDEF")).toBe(true);
    expect(isSlackChannelId("D0123ABCDEF")).toBe(true);
  });

  test("rejects channel names and user ids", () => {
    expect(isSlackChannelId("#ops")).toBe(false);
    expect(isSlackChannelId("U0123ABCDEF")).toBe(false);
    expect(isSlackChannelId("C123")).toBe(false);
  });
});

describe("slackMessageKey", () => {
  test("round-trips the ts, which is only unique per channel", () => {
    const key = slackMessageKey("C0OPSCHAN", "1787200000.000100");

    expect(key).toBe("C0OPSCHAN:1787200000.000100");
    expect(slackMessageTs(key)).toBe("1787200000.000100");
  });
});
