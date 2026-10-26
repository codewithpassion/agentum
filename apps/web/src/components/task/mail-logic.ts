// The pure helpers behind the task view's mail card and its trigger step: the
// mail that started a run, the receipt with that trigger filled in, and the
// rows of a thread's messages.

import type { ReceiptStep } from "@repo/db/shared";
import type { MailThreadView } from "#/integrations/trpc/types";
import {
  directionLabel,
  type MailTone,
  messageStatusChip,
  parseAddresses,
} from "../agent/profile/sheets/mail-logic.ts";

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

/** The inbound message that started run `runId`: its first recipient is the agent's address, its first sender and subject fill the rest. Null when no inbound message of the thread has that runId, or its addresses are unreadable (use parseAddresses; empty list means null). A blank subject becomes "(no subject)". */
export const mailTriggerOf = (
  thread: MailThreadView,
  runId: string
): MailTrigger | null => {
  const message = thread.messages.find(
    (item) => item.direction === "in" && item.runId === runId
  );
  if (!message) {
    return null;
  }
  const [address] = parseAddresses(message.toAddresses);
  if (address === undefined) {
    return null;
  }
  const subject = message.subject.trim();
  return {
    address,
    sender: senderOf(message),
    subject: subject === "" ? NO_SUBJECT : subject,
  };
};

/** The receipt with its first step, when it is a trigger step, reading "Mail to <address>" (title) and "From <sender>: <subject>" (detail). Other steps and the array order stay unchanged; null trigger returns the steps as given. Do not mutate the input. */
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

/** One message of the card: `who` is the sender for an inbound message and the recipients joined by ", " for an outbound one (empty list gives "unknown"); `label` is directionLabel(direction); `chip` is messageStatusChip(status). */
export interface MailMessageRow {
  chip: { label: string; tone: MailTone } | null;
  id: string;
  label: string;
  subject: string;
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
    subject: message.subject,
    who: whoOf(message),
  }));
