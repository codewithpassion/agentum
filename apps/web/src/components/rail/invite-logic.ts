import type { InviteRole } from "@repo/services/workspaces";

/** The roles the invite dialog offers, `Member` first because it is the default. */
export const INVITE_ROLE_OPTIONS: readonly {
  label: string;
  value: InviteRole;
}[] = [
  { label: "Member", value: "org:member" },
  { label: "Admin", value: "org:admin" },
];

export const DEFAULT_INVITE_ROLE: InviteRole = "org:member";

/** Whether the dialog's Send button is live: an address is typed and no send is running. */
export function canSendInvite({
  email,
  pending,
}: {
  email: string;
  pending: boolean;
}): boolean {
  return email.trim() !== "" && !pending;
}

/** What the dialog says once Clerk has queued the email. */
export function inviteSentMessage(email: string): string {
  return `Invitation sent to ${email.trim()}.`;
}

/** Clerk's `appearance` for the member profile: hides its own invite button, so nobody sends the misrouted kind. */
export const MEMBER_PROFILE_APPEARANCE = {
  elements: { membersPageInviteButton: { display: "none" } },
} as const;
