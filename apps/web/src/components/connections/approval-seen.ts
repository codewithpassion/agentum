/** What a person looked at when they approved: where the credential or the calls will go. */
export interface ApprovalSeen {
  origin: string;
  tokenUrl: string | null;
}

/**
 * The destination to send back with an approval. A refreshed card that moved
 * to another origin puts the new one in `pending*`, and that is the one the
 * person is shown. Null when no origin is known, so there is nothing to approve.
 */
export const approvalSeen = (summary: {
  pendingOrigin: string | null;
  pendingTokenUrl: string | null;
  peerOrigin: string | null;
  tokenUrl: string | null;
}): ApprovalSeen | null => {
  const origin = summary.pendingOrigin ?? summary.peerOrigin;
  if (origin === null) {
    return null;
  }
  return {
    origin,
    tokenUrl: summary.pendingTokenUrl ?? summary.tokenUrl,
  };
};

/**
 * The destination to approve from a Needs you card, which shows only a host.
 * An outside agent we call has a credential that goes to the address, so it is
 * approved on its own page where the full origin and token URL show. A
 * Harbourmaster peer is approved only while its address is still the host the
 * card named.
 */
export const approvalFromCard = (
  summary: Parameters<typeof approvalSeen>[0] & { peerKind: string },
  shownHost: string | null
): { seen: ApprovalSeen } | { reason: string } => {
  if (summary.peerKind === "a2a_outbound") {
    return { reason: "Open this connection to see where the credential goes." };
  }
  const seen = approvalSeen(summary);
  if (seen === null) {
    return { reason: "This connection has no address to approve yet." };
  }
  if (new URL(seen.origin).host !== shownHost) {
    return {
      reason:
        "The address changed since this card loaded. Open the connection to look at it.",
    };
  }
  return { seen };
};
