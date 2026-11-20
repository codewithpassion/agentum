import { expect, test } from "bun:test";
import {
  convertAgentMentions,
  guestPostText,
  slackMentionedUserIds,
  TOPIC_TITLE_MAX,
  topicTitle,
} from "./room-text.ts";

test("topicTitle returns a single line message as it is", () => {
  expect(topicTitle("Plan the offsite")).toBe("Plan the offsite");
});

test("topicTitle takes the first non-blank line of a multi-line message", () => {
  expect(topicTitle("First line\nsecond line\nthird")).toBe("First line");
});

test("topicTitle skips leading blank lines", () => {
  expect(topicTitle("\n  \n\t\nReal title\nbody")).toBe("Real title");
});

test("topicTitle collapses runs of whitespace and trims the ends", () => {
  expect(topicTitle("   Hello \t   big   world   ")).toBe("Hello big world");
});

test("topicTitle keeps a title of exactly TOPIC_TITLE_MAX characters whole", () => {
  const title = "a".repeat(TOPIC_TITLE_MAX);
  expect(topicTitle(title)).toBe(title);
});

test("topicTitle cuts a longer title to TOPIC_TITLE_MAX with an ellipsis", () => {
  const title = topicTitle("b".repeat(TOPIC_TITLE_MAX + 1));
  expect(title).toBe(`${"b".repeat(TOPIC_TITLE_MAX - 1)}…`);
  expect(title.length).toBe(TOPIC_TITLE_MAX);
});

test("topicTitle trims the space left at the cut before the ellipsis", () => {
  const head = "c".repeat(TOPIC_TITLE_MAX - 2);
  const title = topicTitle(`${head} tail words that run on`);
  expect(title).toBe(`${head}…`);
  expect(title.length).toBeLessThanOrEqual(TOPIC_TITLE_MAX);
});

test("topicTitle falls back when the message has no non-blank line", () => {
  expect(topicTitle("")).toBe("Slack message");
  expect(topicTitle("  \n\t\n  ")).toBe("Slack message");
});

test("slackMentionedUserIds reads ids with and without the name part", () => {
  expect(slackMentionedUserIds("hi <@U123> and <@U456|ann>")).toEqual([
    "U123",
    "U456",
  ]);
});

test("slackMentionedUserIds drops repeats and keeps first-appearance order", () => {
  expect(slackMentionedUserIds("<@UB> <@UA|x> <@UB|bee> <@UA> <@UC>")).toEqual([
    "UB",
    "UA",
    "UC",
  ]);
});

test("slackMentionedUserIds ignores channel, group and link markup", () => {
  expect(
    slackMentionedUserIds(
      "<!channel> <#C1|general> <https://example.com|site> <@U9>"
    )
  ).toEqual(["U9"]);
});

test("slackMentionedUserIds returns nothing for text without mentions", () => {
  expect(slackMentionedUserIds("no mentions here")).toEqual([]);
});

test("convertAgentMentions replaces a known bot id with its slug", () => {
  const slugs = new Map([["UBOT", "bruce"]]);
  expect(convertAgentMentions("<@UBOT> hi", slugs)).toBe("@bruce hi");
});

test("convertAgentMentions replaces a known id that has a name part", () => {
  const slugs = new Map([["UBOT", "bruce"]]);
  expect(convertAgentMentions("hi <@UBOT|bruce_bot>!", slugs)).toBe(
    "hi @bruce!"
  );
});

test("convertAgentMentions leaves an unknown id alone", () => {
  const slugs = new Map([["UBOT", "bruce"]]);
  expect(convertAgentMentions("hi <@UHUMAN|ann> and <@UBOT>", slugs)).toBe(
    "hi <@UHUMAN|ann> and @bruce"
  );
});

test("convertAgentMentions replaces every mention of the same agent", () => {
  const slugs = new Map([["UBOT", "bruce"]]);
  expect(convertAgentMentions("<@UBOT> and <@UBOT|bruce>", slugs)).toBe(
    "@bruce and @bruce"
  );
});

test("convertAgentMentions keeps the spacing around a replacement", () => {
  const slugs = new Map([["UBOT", "bruce"]]);
  expect(convertAgentMentions("  hi <@UBOT>  ", slugs)).toBe("  hi @bruce  ");
});

test("convertAgentMentions leaves text alone when nothing is mapped", () => {
  expect(convertAgentMentions("<@U1> <#C1|x>", new Map())).toBe(
    "<@U1> <#C1|x>"
  );
});

test("guestPostText labels the post with the guest name", () => {
  expect(guestPostText("Ann Lee", "hello")).toBe(
    "Ann Lee (Slack guest): hello"
  );
});

test("guestPostText collapses and trims the guest name", () => {
  expect(guestPostText("  Ann \n  Lee  ", "hi")).toBe(
    "Ann Lee (Slack guest): hi"
  );
});

test("guestPostText cuts a long guest name to 80 characters", () => {
  const label = guestPostText("n".repeat(100), "hi");
  expect(label).toBe(`${"n".repeat(80)} (Slack guest): hi`);
});

test("guestPostText falls back to Someone for an empty name", () => {
  expect(guestPostText("   ", "hi")).toBe("Someone (Slack guest): hi");
  expect(guestPostText("", "hi")).toBe("Someone (Slack guest): hi");
});
