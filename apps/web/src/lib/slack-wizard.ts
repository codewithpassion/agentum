import type { SlackApp } from "./api";

/**
 * The Slack wizard's step is derived, never stored: the row's status is the
 * whole state, so a reload in the middle of the setup resumes where it left off
 * rather than starting over (docs/plan-slack-apps-per-agent.md, "Wizard UX").
 *
 * `error` means the last token verification failed, not that the connection is
 * gone - the fix is another paste, so it lands on the same step as `draft`.
 */
export type SlackWizardStep = "connect" | "create" | "done";

export const slackWizardStep = (app: SlackApp | null): SlackWizardStep => {
  if (!app) {
    return "create";
  }
  return app.status === "active" ? "done" : "connect";
};

/**
 * What to say above the token form. A `draft` app has never held credentials; an
 * `error` app still holds the ones it had, and they keep working until the next
 * paste replaces them - which is the difference worth telling the user about.
 */
export const slackConnectHint = (app: SlackApp): string =>
  app.status === "error"
    ? "The last tokens were rejected. Any tokens stored before that keep working until you replace them below."
    : "Once the app exists in Slack and is installed, copy its two credentials in here.";
