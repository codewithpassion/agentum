import { expect, test } from "bun:test";
import type { RailItem } from "@repo/db/shared";
import {
  assigneeOf,
  type CardFacts,
  dueFrom,
  escalationTarget,
  groupKey,
  isEscalated,
  isMine,
  mailTitle,
  plainStatus,
  plainTitle,
  problemDetail,
  sortNeedsYou,
} from "./logic.ts";

test.each([
  ["Re: Quote", "Quote"],
  ["RE: Fwd:  re: Hi", "Hi"],
  ["Fw: Invoice", "Invoice"],
  ["  Re:   Padded  ", "Padded"],
  ["Invoice", "Invoice"],
  ["Regarding Re: x", "Regarding Re: x"],
  ["Re:", ""],
])("mailTitle(%p) is %p", (subject, expected) => {
  expect(mailTitle(subject)).toBe(expected);
});

test.each([
  [["ada@acme.io", "bob@ACME.io"], "acme.io"],
  [["ada@gmail.com", "Bob@GMAIL.com"], "ada@gmail.com,bob@gmail.com"],
  [["ada@acme.io", "x@other.com"], "acme.io,other.com"],
  [["a@acme.io", "a@acme.io"], "acme.io"],
  [["ada@gmail.com", "ada@acme.io"], "acme.io,ada@gmail.com"],
  [[], null],
  [["not-an-address"], null],
])("groupKey(%p) is %p", (addresses, expected) => {
  expect(groupKey(addresses)).toBe(expected);
});

const UTC_WED = {
  dayStart: "2026-10-30T00:00:00Z",
  messageAt: "2026-10-28T09:00:00Z",
};
const UTC_FRI = {
  dayStart: "2026-10-30T00:00:00Z",
  messageAt: "2026-10-30T09:00:00Z",
};
// Viewer at UTC+11: local midnight is 13:00Z. The message is Thursday 07:00 local.
const EAST = {
  dayStart: "2026-10-25T13:00:00Z",
  messageAt: "2026-10-28T20:00:00Z",
};
// Viewer at UTC-5: local midnight is 05:00Z. The message is Thursday 22:00 local.
const WEST = {
  dayStart: "2026-10-30T05:00:00Z",
  messageAt: "2026-10-30T03:00:00Z",
};

test.each([
  ["This is urgent.", UTC_WED, "2026-10-28T23:59:59.999Z"],
  ["Need it asap", UTC_WED, "2026-10-28T23:59:59.999Z"],
  ["Send it today", UTC_WED, "2026-10-28T23:59:59.999Z"],
  ["Send it tomorrow", UTC_WED, "2026-10-29T23:59:59.999Z"],
  ["by 9am tomorrow", UTC_WED, "2026-10-29T09:00:00.000Z"],
  ["by 12am tomorrow", UTC_WED, "2026-10-29T00:00:00.000Z"],
  ["by 12pm tomorrow", UTC_WED, "2026-10-29T12:00:00.000Z"],
  ["by 9:30 pm tomorrow", UTC_WED, "2026-10-29T21:30:00.000Z"],
  ["by 17:45 tomorrow", UTC_WED, "2026-10-29T17:45:00.000Z"],
  ["by 5:30pm friday", UTC_WED, "2026-10-30T17:30:00.000Z"],
  ["by Friday", UTC_FRI, "2026-10-30T23:59:59.999Z"],
  ["by Wednesday", UTC_WED, "2026-10-28T23:59:59.999Z"],
  ["by Monday", UTC_WED, "2026-11-02T23:59:59.999Z"],
  ["Pay by 30 November", UTC_WED, "2026-11-30T23:59:59.999Z"],
  ["by 30 Nov 2027", UTC_WED, "2027-11-30T23:59:59.999Z"],
  ["by 1st of December", UTC_WED, "2026-12-01T23:59:59.999Z"],
  ["by 3 October 2026", UTC_WED, "2026-10-03T23:59:59.999Z"],
  [
    "by 30 November",
    { dayStart: UTC_WED.dayStart, messageAt: "2026-12-01T09:00:00Z" },
    "2027-11-30T23:59:59.999Z",
  ],
  ["by 31 February", UTC_WED, null],
  ["by 29 February", UTC_WED, null],
  ["tomorrow, by 30 November", UTC_WED, "2026-10-29T23:59:59.999Z"],
  ["urgent, by Friday", UTC_WED, "2026-10-28T23:59:59.999Z"],
  ["Can you look at this?", UTC_WED, null],
  ["by 9am", UTC_WED, null],
  ["today", EAST, "2026-10-29T12:59:59.999Z"],
  ["by 9am tomorrow", EAST, "2026-10-29T22:00:00.000Z"],
  ["tomorrow", WEST, "2026-10-31T04:59:59.999Z"],
  ["by 5pm friday", WEST, "2026-10-30T22:00:00.000Z"],
  ["by Thursday", WEST, "2026-10-30T04:59:59.999Z"],
])("dueFrom(%p) is %p", (text, ctx, expected) => {
  expect(dueFrom(text, ctx)).toBe(expected);
});

const card = (overrides: Partial<CardFacts>): CardFacts => ({
  agentName: "Ada",
  kind: "approval",
  mail: null,
  title: "Ada asks for approval",
  toolKey: null,
  toolName: null,
  ...overrides,
});

test("plainTitle and plainStatus for a mail approval", () => {
  const mail = {
    mail: {
      recipientName: "Ada Lovelace",
      subject: "Re: Quote for Q4",
      to: ["ada@acme.io"],
    },
  };
  expect(plainTitle(card(mail))).toBe("Reply to Ada: Quote for Q4");
  expect(plainStatus(card(mail))).toBe("Reply ready");
});

test.each([
  [
    { mail: { recipientName: null, subject: "", to: ["ada@x.com"] } },
    "Reply to Ada",
  ],
  [{ mail: { recipientName: "  ", subject: "Re:", to: [] } }, "Reply to them"],
])("mail approval title falls back: %p", (overrides, expected) => {
  expect(plainTitle(card(overrides))).toBe(expected);
});

test.each([
  ["jane.doe@harcourt-logistics.example", "Jane Doe"],
  ["tom.reid@acme.com", "Tom Reid"],
  ["accounts@acme.com", "Accounts"],
  ["j_smith99@acme.com", "J Smith"],
  ["ANNA-LEE@acme.com", "Anna Lee"],
  ["12345@acme.com", "12345@acme.com"],
  ["+@acme.com", "+@acme.com"],
])("mail approval without a name reads %p as %p", (address, expected) => {
  const mail = { recipientName: null, subject: "", to: [address] };
  expect(plainTitle(card({ mail }))).toBe(`Reply to ${expected}`);
});

test("plainTitle for an approval with a platform tool label", () => {
  const c = card({ toolKey: "harbourmaster/artifact_create" });
  expect(plainTitle(c)).toBe("Ada asks before publishing a new artifact");
  expect(plainStatus(c)).toBe("Needs your OK");
});

test("plainTitle for an approval with an unknown tool key", () => {
  const c = card({ toolKey: "xero/create_bill" });
  expect(plainTitle(c)).toBe("Ada asks before create bill");
});

test.each([
  [
    { toolKey: null, toolName: "xero__create_bill" },
    "Ada asks before create bill",
  ],
  [{ toolKey: null, toolName: null }, "Ada asks before using a tool"],
  [{ toolKey: "", toolName: "-_-" }, "Ada asks before using a tool"],
])("plainTitle for a tool without a label: %p", (overrides, expected) => {
  expect(plainTitle(card(overrides))).toBe(expected);
});

test("plainTitle and plainStatus keep the title for other kinds", () => {
  const question = card({
    kind: "question",
    title: "Ada: which date?",
  });
  expect(plainTitle(question)).toBe("Ada: which date?");
  expect(plainStatus(question)).toBe("Ada asks");

  const proposal = card({
    kind: "routine_proposal",
    title: "Weekly digest",
  });
  expect(plainTitle(proposal)).toBe("Weekly digest");
  expect(plainStatus(proposal)).toBe("Ada proposed a routine");
});

test.each([
  ["bounced", "Mail bounced"],
  ["interrupted", "Stopped part way"],
  ["failed", "Failed"],
  [null, "Failed"],
  [undefined, "Failed"],
] as const)("problem %p reads %p", (problem, expected) => {
  const c = card({ kind: "problem", problem, title: "Mail to Ada" });
  expect(plainTitle(c)).toBe("Mail to Ada");
  expect(plainStatus(c)).toBe(expected);
});

test.each(["a2a_message", "a2a_connection"] as const)(
  "%p keeps the desk title and reads as waiting for approval",
  (kind) => {
    const c = card({ kind, title: "Bob sent a message" });
    expect(plainTitle(c)).toBe("Bob sent a message");
    expect(plainStatus(c)).toBe("Waiting for approval");
  }
);

const MEMBERS = new Set(["u1", "u2"]);

test.each([
  [{ createdBy: "u2", ownerUserId: "u1" }, MEMBERS, "u1"],
  [{ createdBy: "u2", ownerUserId: null }, MEMBERS, "u2"],
  [{ createdBy: "u2", ownerUserId: "u3" }, MEMBERS, null],
  [{ createdBy: "u2", ownerUserId: "u3" }, null, "u3"],
  [{ createdBy: "u2", ownerUserId: null }, null, "u2"],
  [{ createdBy: "", ownerUserId: null }, null, null],
] as const)("assigneeOf(%p, members) is %p", (agent, members, expected) => {
  expect(assigneeOf(agent, members)).toBe(expected);
});

const AT = "2026-10-28T08:00:00.000Z";
const FOUR_HOURS = 4 * 60 * 60_000;

test("isEscalated turns true at four hours", () => {
  const at = Date.parse(AT);
  expect(isEscalated(AT, new Date(at + FOUR_HOURS - 1))).toBe(false);
  expect(isEscalated(AT, new Date(at + FOUR_HOURS))).toBe(true);
  expect(isEscalated(AT, new Date(at + FOUR_HOURS + 1))).toBe(true);
});

const ESCALATED = new Date(Date.parse(AT) + FOUR_HOURS);
const FRESH = new Date(Date.parse(AT) + FOUR_HOURS - 1);

test.each([
  [
    {
      assigneeUserId: "u1",
      at: AT,
      backupUserId: "u2",
      memberIds: MEMBERS,
      now: ESCALATED,
    },
    "u2",
  ],
  [
    {
      assigneeUserId: "u1",
      at: AT,
      backupUserId: "u2",
      memberIds: MEMBERS,
      now: FRESH,
    },
    null,
  ],
  [
    {
      assigneeUserId: "u2",
      at: AT,
      backupUserId: "u2",
      memberIds: MEMBERS,
      now: ESCALATED,
    },
    null,
  ],
  [
    {
      assigneeUserId: "u1",
      at: AT,
      backupUserId: "u9",
      memberIds: MEMBERS,
      now: ESCALATED,
    },
    null,
  ],
  [
    {
      assigneeUserId: "u1",
      at: AT,
      backupUserId: "u9",
      memberIds: null,
      now: ESCALATED,
    },
    "u9",
  ],
  [
    {
      assigneeUserId: "u1",
      at: AT,
      backupUserId: null,
      memberIds: null,
      now: ESCALATED,
    },
    null,
  ],
] as const)("escalationTarget case %#", (input, expected) => {
  expect(escalationTarget(input)).toBe(expected);
});

test.each([
  [
    { assigneeUserId: "u1", escalatedToMe: false, memberLookupFailed: false },
    true,
  ],
  [
    { assigneeUserId: "u2", escalatedToMe: true, memberLookupFailed: false },
    true,
  ],
  [
    { assigneeUserId: "u2", escalatedToMe: false, memberLookupFailed: false },
    false,
  ],
  [
    { assigneeUserId: null, escalatedToMe: false, memberLookupFailed: false },
    true,
  ],
  [
    { assigneeUserId: "u2", escalatedToMe: false, memberLookupFailed: true },
    true,
  ],
] as const)("isMine case %#", (input, expected) => {
  expect(isMine({ ...input, userId: "u1" })).toBe(expected);
});

test.each([
  [
    {
      assigneeUserId: "u2",
      escalatedToMe: false,
      memberLookupFailed: false,
      ownedByMe: true,
    },
    true,
  ],
  [
    {
      assigneeUserId: "u2",
      escalatedToMe: false,
      memberLookupFailed: false,
      ownedByMe: false,
    },
    false,
  ],
  [
    { assigneeUserId: "u2", escalatedToMe: false, memberLookupFailed: false },
    false,
  ],
] as const)("isMine with ownedByMe case %#", (input, expected) => {
  expect(isMine({ ...input, userId: "u1" })).toBe(expected);
});

const item = (id: string, at: string, dueAt: string | null): RailItem => ({
  assigneeName: null,
  assigneeUserId: null,
  cards: [
    {
      agentId: "agent-1",
      agentName: "Ada",
      at,
      detail: "",
      expiresAt: null,
      id: `card-${id}`,
      kind: "question",
      mail: null,
      passedOnBy: null,
      runId: null,
      status: "",
      threadId: null,
      title: "",
    },
  ],
  dueAt,
  escalatedToMe: false,
  id,
  mine: true,
});

test("sortNeedsYou puts dated items first, then undated oldest first", () => {
  const items = [
    item("new", "2026-10-05T10:00:00Z", null),
    item("late", "2026-10-01T10:00:00Z", "2026-10-29T10:00:00Z"),
    item("old", "2026-10-01T09:00:00Z", null),
    item("soon", "2026-10-02T10:00:00Z", "2026-10-28T10:00:00Z"),
    item("tie-b", "2026-10-05T10:00:00Z", null),
  ];
  const sorted = sortNeedsYou(items);
  expect(sorted.map((i) => i.id)).toEqual([
    "soon",
    "late",
    "old",
    "new",
    "tie-b",
  ]);
  expect(sorted).not.toBe(items);
  expect(items.map((i) => i.id)).toEqual([
    "new",
    "late",
    "old",
    "soon",
    "tie-b",
  ]);
});

test("sortNeedsYou breaks ties by id", () => {
  const sorted = sortNeedsYou([
    item("z", "2026-10-01T10:00:00Z", "2026-10-28T10:00:00Z"),
    item("y", "2026-10-01T10:00:00Z", "2026-10-28T10:00:00Z"),
  ]);
  expect(sorted.map((i) => i.id)).toEqual(["y", "z"]);
});

test.each([
  [
    {
      agentName: "Ada",
      bandText: "Mail to a@x.io bounced",
      problem: "bounced",
    },
    "Mail to a@x.io bounced",
  ],
  [
    { agentName: "Ada", bandText: "x", problem: "failed" },
    "Ada stopped before finishing",
  ],
  [
    { agentName: "Ada", bandText: "x", problem: "interrupted" },
    "Ada stopped before finishing",
  ],
  [
    { agentName: "", bandText: "x", problem: null },
    "This work stopped before finishing",
  ],
] as const)("problemDetail %#", (input, expected) => {
  expect(problemDetail(input)).toBe(expected);
});
