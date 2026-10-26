import type {
  MailboxStatus,
  MailDirection,
  MailMessageStatus,
} from "@repo/db/shared";

export type MailTone = "default" | "on" | "warn" | "bad";

const MAIL_TOOL_PREFIX = "mail:";

const addressOf = (item: unknown): string | null => {
  if (typeof item === "string") {
    return item.trim() || null;
  }
  if (typeof item === "object" && item !== null && "address" in item) {
    const { address } = item;
    if (typeof address === "string" && address.trim()) {
      return address.trim();
    }
  }
  return null;
};

const isAddress = (address: string | null): address is string =>
  address !== null;

/** Plain addresses from a db address column. Anything unreadable gives []. */
export const parseAddresses = (json: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.map(addressOf).filter(isAddress);
  }
  if (typeof parsed === "object") {
    return [addressOf(parsed)].filter(isAddress);
  }
  return [];
};

export const directionLabel = (direction: MailDirection): string =>
  direction === "in" ? "Received" : "Sent";

const MESSAGE_CHIPS: Record<
  MailMessageStatus,
  { label: string; tone: MailTone } | null
> = {
  bounced: { label: "Bounced", tone: "bad" },
  expired: { label: "Expired", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
  held: { label: "Held", tone: "warn" },
  received: null,
  rejected: { label: "Rejected", tone: "bad" },
  sent: { label: "Sent", tone: "on" },
};

export const messageStatusChip = (
  status: MailMessageStatus
): { label: string; tone: MailTone } | null => MESSAGE_CHIPS[status];

const APPROVAL_NOTES: Record<MailMessageStatus, string | null> = {
  bounced: "It came back undelivered.",
  expired: "Nobody answered in time, so it was not sent.",
  failed: "It could not be sent.",
  held: "Waiting for your approval before it goes out.",
  received: null,
  rejected: "You said no, so it was not sent.",
  sent: null,
};

export const approvalNote = (status: MailMessageStatus): string | null =>
  APPROVAL_NOTES[status];

const MAILBOX_LABELS: Record<MailboxStatus, { label: string; tone: MailTone }> =
  {
    active: { label: "Active", tone: "on" },
    disabled: { label: "Off", tone: "default" },
    failed: { label: "Failed", tone: "bad" },
    provisioning: { label: "Setting up", tone: "default" },
  };

export const mailboxStatusLabel = (
  status: MailboxStatus
): { label: string; tone: MailTone } => MAILBOX_LABELS[status];

/** Bare addresses of the "allow" mail rules, sorted. */
export const allowedMailAddresses = (
  rules: readonly { toolKey: string; mode: string }[]
): string[] =>
  rules
    .filter(
      (rule) =>
        rule.mode === "allow" && rule.toolKey.startsWith(MAIL_TOOL_PREFIX)
    )
    .map((rule) => rule.toolKey.slice(MAIL_TOOL_PREFIX.length))
    .sort();
