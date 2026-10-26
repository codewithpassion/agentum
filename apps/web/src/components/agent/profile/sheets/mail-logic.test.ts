import { expect, test } from "bun:test";
import { mailToolKey } from "@repo/db/shared";
import {
  allowedMailAddresses,
  approvalNote,
  directionLabel,
  latestMessageState,
  mailboxStatusLabel,
  messageStatusChip,
  parseAddresses,
} from "./mail-logic.ts";

test("parseAddresses reads a plain string array", () => {
  expect(parseAddresses('["a@x.com","b@x.com"]')).toEqual([
    "a@x.com",
    "b@x.com",
  ]);
});

test("parseAddresses reads objects in an array and a single object", () => {
  expect(
    parseAddresses('[{"address":"a@x.com","name":"Ann"},"b@x.com"]')
  ).toEqual(["a@x.com", "b@x.com"]);
  expect(parseAddresses('{"address":"c@x.com","name":"Cy"}')).toEqual([
    "c@x.com",
  ]);
});

test("parseAddresses returns [] for invalid JSON and other shapes", () => {
  expect(parseAddresses("not json")).toEqual([]);
  expect(parseAddresses("")).toEqual([]);
  expect(parseAddresses("42")).toEqual([]);
  expect(parseAddresses("null")).toEqual([]);
  expect(parseAddresses('"a@x.com"')).toEqual([]);
});

test("parseAddresses skips items without an address", () => {
  expect(parseAddresses('[{"name":"Ann"},5,"",{"address":"b@x.com"}]')).toEqual(
    ["b@x.com"]
  );
});

test("directionLabel names received and sent mail", () => {
  expect(directionLabel("in")).toBe("Received");
  expect(directionLabel("out")).toBe("Sent");
});

test("messageStatusChip maps each status to its chip", () => {
  expect(messageStatusChip("received")).toBeNull();
  expect(messageStatusChip("held")).toEqual({ label: "Held", tone: "warn" });
  expect(messageStatusChip("sent")).toEqual({ label: "Sent", tone: "on" });
  expect(messageStatusChip("rejected")).toEqual({
    label: "Rejected",
    tone: "bad",
  });
  expect(messageStatusChip("expired")).toEqual({
    label: "Expired",
    tone: "bad",
  });
  expect(messageStatusChip("bounced")).toEqual({
    label: "Bounced",
    tone: "bad",
  });
  expect(messageStatusChip("failed")).toEqual({ label: "Failed", tone: "bad" });
});

test("approvalNote explains the states that need a word", () => {
  expect(approvalNote("held")).toBe(
    "Waiting for your approval before it goes out."
  );
  expect(approvalNote("rejected")).toBe("You said no, so it was not sent.");
  expect(approvalNote("expired")).toBe(
    "Nobody answered in time, so it was not sent."
  );
  expect(approvalNote("bounced")).toBe("It came back undelivered.");
  expect(approvalNote("failed")).toBe("It could not be sent.");
  expect(approvalNote("received")).toBeNull();
  expect(approvalNote("sent")).toBeNull();
});

test("latestMessageState picks the newest message regardless of order", () => {
  const messages = [
    {
      createdAt: "2026-10-02T10:00:00.000Z",
      direction: "out" as const,
      status: "sent" as const,
    },
    {
      createdAt: "2026-10-03T08:00:00.000Z",
      direction: "in" as const,
      status: "received" as const,
    },
    {
      createdAt: "2026-10-01T09:00:00.000Z",
      direction: "out" as const,
      status: "held" as const,
    },
  ];
  expect(latestMessageState(messages)).toEqual({
    direction: "in",
    status: "received",
  });
});

test("latestMessageState is null for an empty list", () => {
  expect(latestMessageState([])).toBeNull();
});

test("mailboxStatusLabel maps each mailbox status", () => {
  expect(mailboxStatusLabel("provisioning")).toEqual({
    label: "Setting up",
    tone: "default",
  });
  expect(mailboxStatusLabel("active")).toEqual({ label: "Active", tone: "on" });
  expect(mailboxStatusLabel("failed")).toEqual({
    label: "Failed",
    tone: "bad",
  });
  expect(mailboxStatusLabel("disabled")).toEqual({
    label: "Off",
    tone: "default",
  });
});

test("allowedMailAddresses returns sorted bare addresses of allow rules", () => {
  const rules = [
    { mode: "allow", toolKey: mailToolKey("Zed@X.com") },
    { mode: "allow", toolKey: mailToolKey("ann@x.com") },
    { mode: "deny", toolKey: mailToolKey("blocked@x.com") },
    { mode: "allow", toolKey: "shell:ls" },
  ];
  expect(allowedMailAddresses(rules)).toEqual(["ann@x.com", "zed@x.com"]);
});

test("allowedMailAddresses is empty without mail allow rules", () => {
  expect(allowedMailAddresses([])).toEqual([]);
  expect(
    allowedMailAddresses([{ mode: "deny", toolKey: mailToolKey("a@x.com") }])
  ).toEqual([]);
});
