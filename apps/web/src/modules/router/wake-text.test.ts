import { describe, expect, test } from "bun:test";
import {
  composeDigestWake,
  composeImmediateWake,
  type WakeEntry,
} from "./wake-text";

const entry = (overrides: Partial<WakeEntry> = {}): WakeEntry => ({
  authorName: "User",
  body: "can you take a look?",
  channelId: "chan_ops",
  channelKind: "channel",
  channelName: "ops",
  createdAt: 1000,
  messageId: "msg_1",
  threadParentId: null,
  ...overrides,
});

describe("composeImmediateWake", () => {
  test("names the channel, its id, the author and the body", () => {
    const text = composeImmediateWake(entry());

    expect(text).toContain("#ops");
    expect(text).toContain("channelId: chan_ops");
    expect(text).toContain("User: can you take a look?");
    expect(text).toContain("post_message");
  });

  test("frames a DM as a direct message", () => {
    const text = composeImmediateWake(
      entry({ channelKind: "dm", channelName: "Chief of Staff" })
    );

    expect(text).toContain("direct message");
    expect(text).toContain("DM with Chief of Staff");
  });

  test("points at the thread when the message is a reply", () => {
    const text = composeImmediateWake(entry({ threadParentId: "msg_parent" }));

    expect(text).toContain("threadParentId");
    expect(text).toContain("msg_parent");
  });

  test("a top-level channel mention starts a thread under itself", () => {
    const text = composeImmediateWake(entry());

    expect(text).toContain('threadParentId "msg_1"');
  });

  test("a DM reply stays top-level", () => {
    const text = composeImmediateWake(
      entry({ channelKind: "dm", channelName: "Chief of Staff" })
    );

    expect(text).not.toContain("threadParentId");
  });

  test("truncates a body long enough to swamp the wake", () => {
    const text = composeImmediateWake(entry({ body: "x".repeat(9000) }));

    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(9000);
  });
});

describe("composeDigestWake", () => {
  test("groups messages under one heading per channel", () => {
    const text = composeDigestWake([
      entry({ body: "first" }),
      entry({ authorName: "Researcher", body: "second" }),
      entry({
        body: "elsewhere",
        channelId: "chan_random",
        channelName: "random",
      }),
    ]);

    expect(text.match(/channelId: chan_ops/g)).toHaveLength(1);
    expect(text).toContain("channelId: chan_random");
    expect(text).toContain("first");
    expect(text).toContain("Researcher");
    expect(text).toContain("elsewhere");
  });

  test("says how many messages it covers and that a reply is optional", () => {
    const text = composeDigestWake([entry(), entry({ body: "again" })]);

    expect(text).toContain("2 since your last update");
    expect(text).toContain("do not post");
  });
});
