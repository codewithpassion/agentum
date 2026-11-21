import type { TeamDraft } from "@repo/services/agent-builder/team-starters";

/** The starters `agentBuilder.teamFromStarter` accepts. A test checks the list matches the service. */
export const TEAM_STARTERS = [
  {
    key: "sales",
    line: "A lead with lead research, outreach drafts and CRM tidy.",
    title: "Sales",
  },
  {
    key: "back_office",
    line: "A lead with invoice filing, shared drive tidy and a weekly report.",
    title: "Back office",
  },
] as const;

export type StarterKey = (typeof TEAM_STARTERS)[number]["key"];

/** What the dialog shows for review: the draft `teamFromStarter` returns. */
export interface StarterReview {
  draft: TeamDraft;
}

/** True when a member has no runtime, which happens when the workspace has no provider key. */
export const missingRuntime = (review: StarterReview): boolean =>
  review.draft.members.some((member) => member.runsOn === null);
