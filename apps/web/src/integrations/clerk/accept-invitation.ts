/** The query the invitation link carries: Clerk adds the ticket and status, the server adds `org`. */
export interface InvitationSearch {
  org?: string;
  status?: string;
  ticket?: string;
}

/** What `/accept-invitation` shows or does. */
export type InvitationStep =
  /** A signed-in session: check the organisation has a workspace, ask the person to join if they must, make it active, then open `/desk`. */
  | { kind: "activate"; org: string }
  /** A new person: the sign-up form takes the ticket. */
  | { kind: "sign-up" }
  /** A person with an account, or a link whose ticket is spent: the sign-in form, which takes a ticket if there is one. */
  | { kind: "sign-in" }
  /** A signed-in session on a link with no organisation: nothing to activate. */
  | { kind: "desk" };

/**
 * Reads the link Clerk sends the invitee to. `__clerk_status` is `sign_up` for
 * an address with no account, `sign_in` for one with an account, and
 * `complete` when the ticket has been used. A signed-in session ignores the
 * ticket, because the sign-in or sign-up form has already spent it. A link
 * with no ticket, such as a reload after use, falls back to sign-in.
 */
export function invitationStep({
  search,
  signedIn,
}: {
  search: InvitationSearch;
  signedIn: boolean;
}): InvitationStep {
  if (signedIn) {
    return search.org
      ? { kind: "activate", org: search.org }
      : { kind: "desk" };
  }
  return search.ticket && search.status !== "sign_in"
    ? { kind: "sign-up" }
    : { kind: "sign-in" };
}

/** Where the sign-in and sign-up forms send the person: back here, signed in, with the organisation to activate. */
export function invitationReturnPath(org: string | undefined): string {
  return org
    ? `/accept-invitation?org=${encodeURIComponent(org)}`
    : "/accept-invitation";
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The route's search validator: only the three keys, each a non-empty string or absent. */
export function parseInvitationSearch(
  raw: Record<string, unknown>
): InvitationSearch {
  return {
    org: asString(raw.org),
    status: asString(raw.__clerk_status),
    ticket: asString(raw.__clerk_ticket),
  };
}

/**
 * What a signed-in session must do to end up in `org`. An organisation with no
 * `workspaces` row gets nothing: Agentum has no say over it. A person
 * who was already signed in when they opened the link never spent the ticket,
 * so the invitation is still pending. It is accepted only once the person has
 * confirmed, because the link alone, a ticket included, proves nothing about
 * what they want. A member just activates.
 */
export function activationPlan({
  confirmed,
  hasRow,
  invitations,
  memberOrgIds,
  org,
}: {
  confirmed: boolean;
  hasRow: boolean;
  invitations: readonly { id: string; organizationId: string }[];
  memberOrgIds: readonly string[];
  org: string;
}):
  | { kind: "activate" }
  | { kind: "confirm"; invitationId: string }
  | { kind: "accept"; invitationId: string }
  | { kind: "none" } {
  if (!hasRow) {
    return { kind: "none" };
  }
  if (memberOrgIds.includes(org)) {
    return { kind: "activate" };
  }
  const pending = invitations.find(
    (invitation) => invitation.organizationId === org
  );
  if (!pending) {
    return { kind: "none" };
  }
  return { invitationId: pending.id, kind: confirmed ? "accept" : "confirm" };
}
