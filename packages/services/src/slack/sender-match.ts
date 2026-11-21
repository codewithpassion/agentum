/** What matching a Slack user to an Agentum account by their Slack email found. */
export type SenderMatch =
  | { clerkUserId: string; kind: "linked" }
  /** From another Slack team, so their email is not ours to trust. */
  | { kind: "external" }
  | { kind: "none"; reason: "hidden_email" | "no_account" };

/** What the app tells a Slack user it could not match to an Agentum account. */
export const UNLINKED_REPLY =
  "I don't know you yet. Ask an Agentum admin of this workspace to invite you, using the same email address as your Slack profile.";
export const HIDDEN_EMAIL_REPLY =
  "I can't see the email address on your Slack profile, so I can't match you to an Agentum account. Ask an Agentum admin of this workspace to invite you, and make your email visible to apps in your Slack profile.";
