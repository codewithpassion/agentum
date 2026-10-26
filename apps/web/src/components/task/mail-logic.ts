// The pure helpers behind the task view's mail card and its trigger step: the
// mail that started a run, the receipt with that trigger filled in, and the
// rows of a thread's messages.

import type { ReceiptStep } from "@repo/db/shared";
import {
  directionLabel,
  type MailTone,
  messageStatusChip,
  parseAddresses,
} from "#/components/agent/profile/sheets/mail-logic.ts";
import type { MailThreadView } from "#/integrations/trpc/types";

type MailMessageView = MailThreadView["messages"][number];

/** What the trigger step shows for a task a mail started. */
export interface MailTrigger {
  address: string;
  sender: string;
  subject: string;
}

const NO_SUBJECT = "(no subject)";
const UNKNOWN_SENDER = "unknown sender";

/** The first sender of a message, read from its `from_address` JSON. */
const senderOf = (message: MailMessageView): string =>
  parseAddresses(message.fromAddress)[0] ?? UNKNOWN_SENDER;

/**
 * What the trigger step shows for run `runId`, from the inbound message that
 * started it and the agent's own mailbox address. Null when no inbound message
 * of the thread belongs to that run.
 */
export const mailTriggerOf = (
  thread: MailThreadView,
  runId: string,
  address: string
): MailTrigger | null => {
  const message = thread.messages.find(
    (item) => item.direction === "in" && item.runId === runId
  );
  if (!message) {
    return null;
  }
  const subject = message.subject.trim();
  return {
    address,
    sender: senderOf(message),
    subject: subject === "" ? NO_SUBJECT : subject,
  };
};

/** The receipt with its trigger step reading "Mail to <address>" and "From <sender>: <subject>". Steps without a mail trigger, or a first step that is not a trigger, come back as given. */
export const withMailTrigger = (
  steps: ReceiptStep[],
  trigger: MailTrigger | null
): ReceiptStep[] => {
  const [first, ...rest] = steps;
  if (trigger === null || first === undefined || first.kind !== "trigger") {
    return steps;
  }
  return [
    {
      ...first,
      detail: `From ${trigger.sender}: ${trigger.subject}`,
      title: `Mail to ${trigger.address}`,
    },
    ...rest,
  ];
};

/** One message of the card: the sender of an inbound message, the recipients of an outbound one. */
export interface MailMessageRow {
  chip: { label: string; tone: MailTone } | null;
  id: string;
  label: string;
  who: string;
}

const whoOf = (message: MailMessageView): string => {
  if (message.direction === "in") {
    return senderOf(message);
  }
  const recipients = parseAddresses(message.toAddresses);
  return recipients.length === 0 ? "unknown" : recipients.join(", ");
};

/** One row per message of the thread, in the thread's order. */
export const mailMessageRows = (thread: MailThreadView): MailMessageRow[] =>
  thread.messages.map((message) => ({
    chip: messageStatusChip(message.status),
    id: message.id,
    label: directionLabel(message.direction),
    who: whoOf(message),
  }));
