import { describe, expect, test } from "bun:test";
import {
  bodyToSlackText,
  collectUserMentions,
  mirroredText,
  slackTextToBody,
} from "./text";

describe("slackTextToBody", () => {
  test("maps the bot's own mention to the bridged agent", () => {
    const body = slackTextToBody("<@U0BOT> can you summarise this?", {
      agentName: "Chief of Staff",
      botUserId: "U0BOT",
    });

    // This is what makes a Slack mention wake the agent: the stored body has
    // to contain the same @Name the mention parser looks for.
    expect(body).toBe("@Chief of Staff can you summarise this?");
  });

  test("renders other users by display name, falling back to their id", () => {
    const body = slackTextToBody("cc <@U1ALICE> and <@U2BOB>", {
      userNames: new Map([["U1ALICE", "alice"]]),
    });

    expect(body).toBe("cc @alice and @U2BOB");
  });

  test("leaves the bot mention alone when no agent is bridged", () => {
    expect(
      slackTextToBody("<@U0BOT> hi", { agentName: null, botUserId: "U0BOT" })
    ).toBe("@U0BOT hi");
  });

  test("flattens channels, links and special mentions, then unescapes", () => {
    const body = slackTextToBody(
      "<!here> see <#C0OPS|ops> and <https://example.com|the docs> &lt;raw&gt; &amp; more <https://plain.example>"
    );

    expect(body).toBe(
      "@here see #ops and the docs <raw> & more https://plain.example"
    );
  });
});

describe("collectUserMentions", () => {
  test("returns each mentioned user once", () => {
    expect(collectUserMentions("<@U1> <@U2> <@U1|alice>")).toEqual([
      "U1",
      "U2",
    ]);
  });
});

describe("bodyToSlackText", () => {
  test("escapes only the three characters Slack reserves", () => {
    expect(bodyToSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("prefixes the author, since every mirrored post is the same bot", () => {
    expect(mirroredText("on it", "Researcher")).toBe("*Researcher*\non it");
    expect(mirroredText("on it", null)).toBe("on it");
  });
});
