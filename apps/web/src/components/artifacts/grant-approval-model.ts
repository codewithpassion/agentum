// The logic behind the grant approval card: what a proposed app version asks
// for, read from its approval request, and how every grant gets decided.

import { ARTIFACT_GRANT_KINDS, type ArtifactGrantKind } from "@repo/db/shared";
import type { ApprovalDisplay } from "@repo/protocol/requests";
import { z } from "zod";

const PROMOTE_TOOL_NAME = "artifact_promote";
const PROMOTE_TOOL_KEY = "harbourmaster/artifact_promote";
const ALREADY_DECIDED = "already decided";

const promoteInputSchema = z.object({
  artifactId: z.string(),
  grants: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(ARTIFACT_GRANT_KINDS),
      name: z.string().optional(),
      target: z.string(),
    })
  ),
  title: z.string(),
  version: z.number(),
  versionId: z.string(),
});

/** What a proposed app version asks for. */
export interface PromoteApproval {
  agents: string[];
  artifactId: string;
  endpoints: string[];
  /** Every grant to decide, argument-limit rows included. */
  grantIds: string[];
  hosts: string[];
  secrets: string[];
  title: string;
  tools: string[];
  version: number;
  versionId: string;
}

/** A tool target of the form `<tool>#<json>` limits the arguments of a tool. */
const isLimitTarget = (target: string): boolean => target.includes("#");

const unique = (values: string[]): string[] => [...new Set(values)];

/** The promote request behind an approval display, or null for any other approval. */
export const parsePromoteApproval = (
  display: ApprovalDisplay
): PromoteApproval | null => {
  if (
    display.toolName !== PROMOTE_TOOL_NAME ||
    display.toolKey !== PROMOTE_TOOL_KEY
  ) {
    return null;
  }
  const parsed = promoteInputSchema.safeParse(display.input);
  if (!parsed.success) {
    return null;
  }
  const { grants, ...rest } = parsed.data;
  const targets = (kind: ArtifactGrantKind) =>
    unique(grants.filter((g) => g.kind === kind).map((g) => g.target));
  return {
    ...rest,
    // The request snapshots display names; targets remain ids for granting.
    agents: unique(
      grants
        .filter((g) => g.kind === "agent")
        .map((g) => g.name ?? "Unavailable agent")
    ),
    endpoints: targets("endpoint"),
    grantIds: grants.map((grant) => grant.id),
    hosts: targets("host"),
    secrets: targets("secret"),
    tools: targets("tool").filter((target) => !isLimitTarget(target)),
  };
};

export type GrantDecision = "approved" | "rejected";

/**
 * Decides each grant in turn. A grant someone else already decided is skipped.
 * Any other error stops the run and is thrown.
 */
export const decideAll = async (
  grantIds: string[],
  decision: GrantDecision,
  decide: (grantId: string, decision: GrantDecision) => Promise<unknown>
): Promise<void> => {
  for (const grantId of grantIds) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: grants are decided one after the other, and a hard error stops the rest
      await decide(grantId, decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(ALREADY_DECIDED)) {
        throw error;
      }
    }
  }
};
