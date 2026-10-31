// Pure words and rules for the agent connections pages. No React, no calls.
import type {
  A2aConnectionStatus,
  A2aInboundPolicy,
  A2aOutboundPolicy,
  A2aPeerKind,
  A2aTaskState,
  A2aToolPolicy,
} from "@repo/db/shared";

/** The fields of a connection these helpers read. A tRPC `a2a.list` row fits. */
export interface ConnectionLike {
  createdAt: string;
  id: string;
  inboundPolicy: A2aInboundPolicy;
  lastInAt: string | null;
  lastOutAt: string | null;
  outboundPolicy: A2aOutboundPolicy;
  peerKind: A2aPeerKind;
  peerLabel: string | null;
  peerOrigin: string | null;
  pendingOrigin: string | null;
  status: A2aConnectionStatus;
}

/** One line on what a connection is, for empty states and the add menu. */
export const WHAT_A_CONNECTION_IS =
  "A connection lets one of your agents exchange messages with an agent in another workspace or run by someone else, until you revoke it.";

const STATUS_WORDS: Record<A2aConnectionStatus, string> = {
  activating: "Activating",
  active: "Active",
  awaiting_peer: "Waiting for the other side",
  declined: "Declined",
  inviting: "Invite open",
  needs_approval: "Needs approval",
  revoked: "Revoked",
};

export const statusWords = (status: A2aConnectionStatus): string =>
  STATUS_WORDS[status];

/** A connection that ended. It stays listed but nothing can change it. */
export const isEnded = (status: A2aConnectionStatus): boolean =>
  status === "revoked" || status === "declined";

/** A connection that waits for a person on this side. */
export const isPending = (status: A2aConnectionStatus): boolean =>
  status === "needs_approval";

export const peerName = (connection: ConnectionLike): string =>
  connection.peerLabel?.trim() || "Unnamed agent";

/** The host the peer lives on, or null when none is known (an outside client with a key). */
export const peerHost = (connection: ConnectionLike): string | null => {
  const origin = connection.pendingOrigin ?? connection.peerOrigin;
  if (origin === null) {
    return null;
  }
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

const KIND_WORDS: Record<A2aPeerKind, string> = {
  a2a_inbound: "Outside agent with a key",
  a2a_outbound: "Outside agent we call",
  harbourmaster: "Harbourmaster",
};

export const kindWords = (kind: A2aPeerKind): string => KIND_WORDS[kind];

/** Which directions are on: what the peer may send us, and what our agent may send the peer. */
export const directionsOn = (
  connection: Pick<
    ConnectionLike,
    "inboundPolicy" | "outboundPolicy" | "peerKind"
  >
): string[] => {
  const directions: string[] = [];
  if (
    connection.peerKind !== "a2a_outbound" &&
    connection.inboundPolicy !== "off"
  ) {
    directions.push("Receives");
  }
  if (
    connection.peerKind !== "a2a_inbound" &&
    connection.outboundPolicy !== "off"
  ) {
    directions.push("Sends");
  }
  return directions;
};

/** The later of the last message in and out, or null when there was none. */
export const lastActivity = (
  connection: Pick<ConnectionLike, "lastInAt" | "lastOutAt">
): string | null => {
  const times = [connection.lastInAt, connection.lastOutAt].filter(
    (time): time is string => time !== null
  );
  return times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b));
};

const rank = (connection: ConnectionLike): number => {
  if (isPending(connection.status)) {
    return 0;
  }
  return isEnded(connection.status) ? 2 : 1;
};

/** Pending approvals first, live connections next, ended ones last. Newest first within each. */
export const sortConnections = <T extends ConnectionLike>(
  connections: readonly T[]
): T[] =>
  [...connections].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id)
  );

/** What a peer's message may do, said plainly, for the switch beside it. */
export const INBOUND_WORDS: Record<A2aInboundPolicy, string> = {
  approve: "Each incoming message waits for a person to approve it.",
  auto: "A message from this peer starts a run at once, with no one reading it first. Anyone who holds the peer's key can give your agent work.",
  off: "Incoming messages from this peer are refused.",
};

export const TOOL_WORDS: Record<A2aToolPolicy, string> = {
  agent_rules:
    "In a run this peer starts, the agent follows its usual rules for tools and may use them without asking. A machine agent can run shell commands on its computer.",
  ask: "Every tool call in a run this peer starts asks a person first.",
};

export const OUTBOUND_WORDS: Record<A2aOutboundPolicy, string> = {
  approve:
    "A message from your agent to this peer waits for a person, who sees the full text first.",
  auto: "Your agent can send this peer messages with no one reading them first. An injected agent could leak data this way.",
  off: "Your agent may not message this peer.",
};

/** The warning to show beside a switch about to widen, or null when the move is not a widening. */
export const wideningWarning = (change: {
  inboundPolicy?: A2aInboundPolicy;
  outboundPolicy?: A2aOutboundPolicy;
  toolPolicy?: A2aToolPolicy;
}): string | null => {
  if (change.inboundPolicy === "auto") {
    return INBOUND_WORDS.auto;
  }
  if (change.toolPolicy === "agent_rules") {
    return TOOL_WORDS.agent_rules;
  }
  if (change.outboundPolicy === "auto") {
    return OUTBOUND_WORDS.auto;
  }
  return null;
};

/** The two moves that widen trust and need an admin or the agent's owner. */
export const isWidening = (change: {
  inboundPolicy?: A2aInboundPolicy;
  toolPolicy?: A2aToolPolicy;
}): boolean =>
  change.inboundPolicy === "auto" || change.toolPolicy === "agent_rules";

const TASK_STATE_WORDS: Record<A2aTaskState, string> = {
  TASK_STATE_AUTH_REQUIRED: "Waiting for approval",
  TASK_STATE_CANCELED: "Cancelled",
  TASK_STATE_COMPLETED: "Done",
  TASK_STATE_FAILED: "Failed",
  TASK_STATE_INPUT_REQUIRED: "Waiting for an answer",
  TASK_STATE_REJECTED: "Declined",
  TASK_STATE_SUBMITTED: "Queued",
  TASK_STATE_WORKING: "Working",
};

export const taskStateWords = (state: A2aTaskState): string =>
  TASK_STATE_WORDS[state];

const CARD_FILE = /\/\.well-known\/agent-card\.json$/;

/**
 * The URL a Hermes agent calls: the card URL without its `.well-known` file.
 * Hermes finds the card at `<url>/.well-known/agent-card.json`.
 */
export const hermesUrlOfCardUrl = (cardUrl: string): string =>
  cardUrl.replace(CARD_FILE, "");

const yamlString = (value: string): string => JSON.stringify(value);

/** The `a2a_agents` block for `~/.hermes/config.yaml`, ready to paste. */
export const hermesConfigYaml = (input: {
  cardUrl: string;
  name: string;
  token: string;
}): string =>
  [
    "a2a_agents:",
    `  ${yamlString(input.name)}:`,
    `    url: ${yamlString(hermesUrlOfCardUrl(input.cardUrl))}`,
    "    auth:",
    "      type: bearer",
    `      token: ${yamlString(input.token)}`,
  ].join("\n");

/** What a key connection says about approval, for Hermes: it never gets the later answer by itself. */
export const HERMES_APPROVAL_NOTE =
  'With approval on, a Hermes agent gets "waiting for approval" and not the later answer. The answer stays in the session for its next message in that context. Choose "Start a run at once" for this connection if you trust the peer.';

/** What the Hermes operator sets so we may call their agent. */
export const hermesCallEnvironment = (input: {
  publicUrl: string;
  tokenName: string;
}): { name: string; note: string; value: string }[] => [
  {
    name: "A2A_PEER_TOKENS",
    note: "The token Hermes was given, under a name it can look up.",
    value: input.tokenName,
  },
  {
    name: "A2A_TRUSTED_PEERS",
    note: "Names that token, so Hermes accepts calls that carry it.",
    value: input.tokenName,
  },
  {
    name: "A2A_PUBLIC_URL",
    note: "Hermes's own address. It must be HTTPS: Harbourmaster refuses plain HTTP.",
    value: input.publicUrl,
  },
];
