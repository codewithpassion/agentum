import type { GuestGrant } from "@repo/protocol/live";

export type GuestRole = GuestGrant["role"];

/** Trusted Clerk organization-directory adapter. Failure must fail the invite;
 * it must never be treated as 'address is an outsider'. */
export interface GuestDirectoryPort {
  findMemberByEmail: (input: {
    workspaceId: string;
    email: string;
  }) => Promise<{
    userId: string;
    displayName: string;
  } | null>;
}

export interface InvitationEmail {
  artifactTitle: string;
  expiresAt: string | null;
  inviterName: string;
  role: GuestRole;
  to: string;
  workspaceName: string;
}

/** Later EMAIL binding adapter renders escaped HTML and a plain-text alternative.
 * A verified platform sender belongs in that adapter, never client input.
 * These inputs contain credentials: adapters must not log them or persist plaintext.
 * Member links have no invitation credential; only guest invite URLs carry tokens.
 */
export interface GuestEmailPort {
  sendCode: (
    input: InvitationEmail & { code: string; codeExpiresAt: string }
  ) => Promise<void>;
  sendInvitation: (input: InvitationEmail & { url: string }) => Promise<void>;
}

/** Phase 3 runtime integration must authenticate the current session, resolve a
 * fresh grant, and atomically charge the daily cap before starting a run.
 * Never trust a GuestGrant object submitted by the caller as authentication.
 */
export interface GuestRunAuthorizationPort {
  authorizeAndCharge: (input: {
    agentId: string;
    artifactId: string;
    sessionToken: string;
    workspaceId: string;
  }) => Promise<GuestGrant>;
}

/** Trigger processing AFTER the atomic outbox commit. A durable sweep must still
 * retry pending rows after crashes or a failed trigger (L.7 integration).
 */
export interface GuestInvalidationDeliveryPort {
  trigger: () => Promise<void>;
}
