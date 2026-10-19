import { expect, test } from "bun:test";
import { convertMentions, type MentionPerson } from "./mentions.ts";

const DOMINIK: MentionPerson = {
  aliases: ["Dominik Fretz", "dfretz"],
  email: "dominik.fretz@portcity-ai.com",
  externalUserId: "U2",
  slackName: "dominik",
};

const ANN: MentionPerson = {
  aliases: ["Ann Lee"],
  email: "ann@portcity-ai.com",
  externalUserId: "U1",
  slackName: "Ann",
};

test("matches a name by its slackName", () => {
  expect(convertMentions("hi @Ann", [ANN])).toEqual({
    notes: [],
    text: "hi <@U1>",
  });
});

test("matches a name by an alias", () => {
  expect(convertMentions("ping @dfretz", [DOMINIK])).toEqual({
    notes: [],
    text: "ping <@U2>",
  });
});

test("matches a name by the email local part", () => {
  const bob: MentionPerson = {
    aliases: [],
    email: "bob@portcity-ai.com",
    externalUserId: "U3",
    slackName: "Robert",
  };
  expect(convertMentions("ask @bob", [bob])).toEqual({
    notes: [],
    text: "ask <@U3>",
  });
});

test("matches the full email local part with a dot", () => {
  expect(convertMentions("ask @dominik.fretz", [DOMINIK])).toEqual({
    notes: [],
    text: "ask <@U2>",
  });
});

test("matches case-insensitively", () => {
  expect(convertMentions("@DOMINIK and @ann", [DOMINIK, ANN])).toEqual({
    notes: [],
    text: "<@U2> and <@U1>",
  });
});

test("leaves an unknown name as plain text with a note", () => {
  expect(convertMentions("hi @zed", [DOMINIK, ANN])).toEqual({
    notes: ["@zed matched nobody, sent as plain text"],
    text: "hi @zed",
  });
});

test("names the note without the trailing punctuation that was removed", () => {
  expect(convertMentions("hi @zed.", [DOMINIK])).toEqual({
    notes: ["@zed matched nobody, sent as plain text"],
    text: "hi @zed.",
  });
});

test("leaves an ambiguous name as plain text with a note", () => {
  const sam: MentionPerson = {
    aliases: [],
    email: "sam.one@portcity-ai.com",
    externalUserId: "U4",
    slackName: "Sam",
  };
  const samToo: MentionPerson = {
    aliases: [],
    email: "sam.two@portcity-ai.com",
    externalUserId: "U5",
    slackName: "Sam",
  };
  expect(convertMentions("hi @sam", [sam, samToo])).toEqual({
    notes: ["@sam matched more than one person, sent as plain text"],
    text: "hi @sam",
  });
});

test("counts one person matching through two of their own names once", () => {
  const sam: MentionPerson = {
    aliases: ["sam"],
    email: "sam@portcity-ai.com",
    externalUserId: "U4",
    slackName: "Sam",
  };
  expect(convertMentions("hi @sam", [sam])).toEqual({
    notes: [],
    text: "hi <@U4>",
  });
});

test("passes an already written user mention through unchanged", () => {
  expect(convertMentions("<@U0ANN> hi", [ANN])).toEqual({
    notes: [],
    text: "<@U0ANN> hi",
  });
});

test("leaves @here and @channel as plain text with notes", () => {
  expect(convertMentions("@here and @channel", [ANN])).toEqual({
    notes: [
      "@here is not converted, sent as plain text",
      "@channel is not converted, sent as plain text",
    ],
    text: "@here and @channel",
  });
});

test("leaves @everyone as plain text even when a person has that name", () => {
  const everyone: MentionPerson = {
    aliases: [],
    email: "everyone@portcity-ai.com",
    externalUserId: "U6",
    slackName: "everyone",
  };
  expect(convertMentions("@Everyone", [everyone])).toEqual({
    notes: ["@Everyone is not converted, sent as plain text"],
    text: "@Everyone",
  });
});

test("leaves an address untouched without notes", () => {
  expect(convertMentions("write a@dominik.com", [DOMINIK])).toEqual({
    notes: [],
    text: "write a@dominik.com",
  });
});

test("keeps the full stop after a mention", () => {
  expect(convertMentions("hi @dominik.", [DOMINIK])).toEqual({
    notes: [],
    text: "hi <@U2>.",
  });
});

test("converts two mentions in one text", () => {
  expect(convertMentions("@Ann and @dominik,", [DOMINIK, ANN])).toEqual({
    notes: [],
    text: "<@U1> and <@U2>,",
  });
});

test("returns a text without @ as it is", () => {
  expect(convertMentions("no names here", [DOMINIK, ANN])).toEqual({
    notes: [],
    text: "no names here",
  });
});

test("matches a full email address as one name", () => {
  expect(
    convertMentions("ask @dominik.fretz@portcity-ai.com now", [DOMINIK])
  ).toEqual({
    notes: [],
    text: "ask <@U2> now",
  });
});

test("keeps non-ASCII names whole in the note and matches them", () => {
  const zoe: MentionPerson = {
    aliases: ["Zoë"],
    email: "zoe@example.test",
    externalUserId: "U0ZOE",
    slackName: "Zoë",
  };
  expect(convertMentions("hi @zoë", [zoe])).toEqual({
    notes: [],
    text: "hi <@U0ZOE>",
  });
  expect(convertMentions("hi @zoé", [zoe])).toEqual({
    notes: ["@zoé matched nobody, sent as plain text"],
    text: "hi @zoé",
  });
});

test("keeps combining marks in a name, composed or not", () => {
  const priya: MentionPerson = {
    aliases: ["प्रिया"],
    email: "priya@example.test",
    externalUserId: "U0PRIYA",
    slackName: "प्रिया",
  };
  expect(convertMentions("hi @प्रिया.", [priya])).toEqual({
    notes: [],
    text: "hi <@U0PRIYA>.",
  });
  expect(convertMentions("hi @zo\u0065\u0308", [priya])).toEqual({
    notes: ["@zo\u0065\u0308 matched nobody, sent as plain text"],
    text: "hi @zo\u0065\u0308",
  });
});
