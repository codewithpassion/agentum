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
