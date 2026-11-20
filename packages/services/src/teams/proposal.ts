/**
 * A lead's proposal to change a member agent (TM.4). It is an approval request
 * whose tool is `team_propose_change` and whose tool use id is `team:<id>`.
 * The request carries the whole proposal in its display input, so the person
 * who approves sees exactly what is applied. Like a mail approval it outlives
 * the lead's run, and no runtime waits on it.
 */
import { CONTEXT_BUDGETS, EFFORT_LEVELS } from "@repo/db/shared";
import { z } from "zod";
import { idString } from "../shared.ts";

export const TEAM_PROPOSE_TOOL = "team_propose_change";
export const TEAM_PROPOSAL_PREFIX = "team:";

/**
 * The only fields a lead may propose. Access, keys, ask-before rules and
 * connectors are not on the list and never will be.
 */
export const PROPOSAL_FIELDS = [
  "instructions",
  "model",
  "effort",
  "contextBudget",
] as const;
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];

export const PROPOSAL_REASON_MAX = 1000;
/** The approval display holds 8192 bytes of input. Staying under it keeps the value whole. */
export const PROPOSAL_INPUT_MAX_BYTES = 7000;

/** The proposed value as text, by field. `effort` and `contextBudget` take their enum's words. */
export const proposalValueSchemas = {
  contextBudget: z.enum(CONTEXT_BUDGETS),
  effort: z.enum(EFFORT_LEVELS),
  instructions: z.string().max(50_000),
  model: z.string().min(1).max(100),
} as const satisfies Record<ProposalField, z.ZodType<string>>;

/** What a lead sends. */
export const proposeInputSchema = z.strictObject({
  agentId: idString,
  field: z.enum(PROPOSAL_FIELDS),
  reason: z.string().trim().min(1).max(PROPOSAL_REASON_MAX),
  value: z.string(),
});
export type ProposeInput = z.input<typeof proposeInputSchema>;

/** What the approval request stores as its input. */
export const proposalInputSchema = z.strictObject({
  agentId: idString,
  agentName: z.string(),
  field: z.enum(PROPOSAL_FIELDS),
  leadName: z.string(),
  reason: z.string(),
  value: z.string(),
});
export type ProposalInput = z.infer<typeof proposalInputSchema>;

/** True for the approval request of a proposal. */
export const isTeamProposal = (row: {
  toolName: string;
  toolUseId: string;
}): boolean =>
  row.toolName === TEAM_PROPOSE_TOOL &&
  row.toolUseId.startsWith(TEAM_PROPOSAL_PREFIX);

/** The proposal in a request's display, or null when the display holds none (a truncated or foreign input). */
export const proposalOf = (display: {
  input: unknown;
}): ProposalInput | null => {
  const parsed = proposalInputSchema.safeParse(display.input);
  return parsed.success ? parsed.data : null;
};
