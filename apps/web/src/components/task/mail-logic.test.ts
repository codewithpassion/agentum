import { expect, test } from "bun:test";
import type { ReceiptStep } from "@repo/db/shared";
import type { MailThreadView } from "#/integrations/trpc/types";
import {
  mailMessageRows,
  mailTriggerOf,
  withMailTrigger,
} from "./mail-logic.ts";

type MailMessageView = MailThreadView["messages"][number];

const AGENT = "agent@mail.example.com";

/**
 * A thread with the fields the helpers read. The fixture leaves out the
 * columns they never touch, so it is cast to the full view type once here.
 */
const thread = (messages: Partial<MailMessageView>[]): MailThreadView =>
  ({
    messages: messages.map((message, index) => ({
      createdAt: "2026-10-27T10:00:00.000Z",
      direction: "in",
      fromAddress: JSON.stringify({ address: "client@example.com" }),
      id: `m${index + 1}`,
      runId: null,
      status: "received",
      subject: "Hello",
      toAddresses: JSON.stringify([{ address: AGENT }]),
      ...message,
    })),
  }) as unknown as MailThreadView;

const step = (overrides: Partial<ReceiptStep>): ReceiptStep => ({
  countToNext: null,
  detail: "",
  eventIds: [],
  in: [],
  index: 1,
  kind: "trigger",
  out: [],
  state: "done",
  title: "Trigger",
  ...overrides,
});

test("the trigger is the inbound message of the given run, among several", () => {
  const view = thread([
    {
      fromAddress: JSON.stringify({ address: "first@example.com" }),
      id: "a",
      runId: "run_1",
      subject: "One",
    },
    {
      direction: "out",
      id: "b",
      runId: "run_2",
      toAddresses: JSON.stringify(["x@example.com"]),
    },
    {
      fromAddress: JSON.stringify({ address: "second@example.com" }),
      id: "c",
      runId: "run_2",
      subject: "  Two  ",
    },
  ]);
  expect(mailTriggerOf(view, "run_1", AGENT)).toEqual({
    address: AGENT,
    sender: "first@example.com",
    subject: "One",
  });
  expect(mailTriggerOf(view, "run_2", AGENT)).toEqual({
    address: AGENT,
    sender: "second@example.com",
    subject: "Two",
  });
});

test("a run with no inbound message in the thread has no trigger", () => {
  const view = thread([{ runId: "run_1" }]);
  expect(mailTriggerOf(view, "run_9", AGENT)).toBeNull();
});

test("an outbound-only thread has no trigger", () => {
  const view = thread([{ direction: "out", runId: "run_1" }]);
  expect(mailTriggerOf(view, "run_1", AGENT)).toBeNull();
});

test("a blank subject reads as no subject", () => {
  const view = thread([{ runId: "run_1", subject: "   " }]);
  expect(mailTriggerOf(view, "run_1", AGENT)?.subject).toBe("(no subject)");
});

test("the trigger step takes the mail's address, sender and subject", () => {
  const steps = [
    step({ detail: "old", index: 1, state: "done", title: "Trigger" }),
    step({ index: 2, kind: "message", title: "Reply" }),
  ];
  const result = withMailTrigger(steps, {
    address: AGENT,
    sender: "client@example.com",
    subject: "Quote",
  });
  expect(result).toEqual([
    step({
      detail: "From client@example.com: Quote",
      index: 1,
      state: "done",
      title: `Mail to ${AGENT}`,
    }),
    step({ index: 2, kind: "message", title: "Reply" }),
  ]);
  expect(steps.map((item) => item.title)).toEqual(["Trigger", "Reply"]);
});

test("a first step that is not a trigger stays as it is", () => {
  const steps = [step({ kind: "message", title: "Hi" }), step({ index: 2 })];
  const result = withMailTrigger(steps, {
    address: AGENT,
    sender: "client@example.com",
    subject: "Quote",
  });
  expect(result).toEqual(steps);
  expect(result[0]).toBe(steps[0]);
});

test("a null trigger returns the steps unchanged", () => {
  const steps = [step({ title: "Trigger" })];
  expect(withMailTrigger(steps, null)).toEqual(steps);
  expect(withMailTrigger([], null)).toEqual([]);
});

test("message rows show the sender for inbound and the recipients for outbound", () => {
  const view = thread([
    {
      direction: "in",
      fromAddress: JSON.stringify({ address: "client@example.com" }),
      id: "in1",
      status: "received",
      subject: "Hello",
    },
    {
      direction: "out",
      id: "out1",
      status: "sent",
      subject: "Re: Hello",
      toAddresses: JSON.stringify([
        { address: "a@example.com" },
        "b@example.com",
      ]),
    },
    {
      direction: "out",
      id: "out2",
      status: "held",
      subject: "Follow up",
      toAddresses: "[]",
    },
  ]);
  expect(mailMessageRows(view)).toEqual([
    {
      chip: null,
      id: "in1",
      label: "Received",
      who: "client@example.com",
    },
    {
      chip: { label: "Sent", tone: "on" },
      id: "out1",
      label: "Sent",
      who: "a@example.com, b@example.com",
    },
    {
      chip: { label: "Held", tone: "warn" },
      id: "out2",
      label: "Sent",
      who: "unknown",
    },
  ]);
});

test("an empty thread has no rows", () => {
  expect(mailMessageRows(thread([]))).toEqual([]);
});
