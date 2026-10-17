// Pure helpers for the agent Skills tab: which skills an agent carries, what they resolve to, and its proposals.
import type {
  AgentSkill,
  SkillAssignment,
  SkillSummary,
  SkillVersion,
} from "#/integrations/trpc/types";
import { type AgentNames, ownerLabel } from "./skills-logic.ts";

/** The assignments of one agent. */
export const agentAssignments = (
  assignments: readonly SkillAssignment[],
  agentId: string
): SkillAssignment[] =>
  assignments.filter((assignment) => assignment.agentId === agentId);

export interface SkillHeading {
  name: string;
  owner: string;
}

/** A skill's name and owner. A skill missing from the list shows its id and an unknown owner. */
export const skillHeading = (
  skill: SkillSummary | undefined,
  skillId: string,
  agentNames: AgentNames
): SkillHeading =>
  skill === undefined
    ? { name: skillId, owner: "Unknown owner" }
    : {
        name: skill.name,
        owner: ownerLabel(skill.ownerAgentId, agentNames),
      };

export interface AssignedSkill extends SkillHeading {
  pinned: boolean;
  pinnedVersion: number | null;
  skillId: string;
  /** The version in use, or null when the skill has no approved version. */
  version: number | null;
}

/** One row per assignment, joined with the skill's name and what the agent resolves to. */
export const assignedSkills = (
  assignments: readonly SkillAssignment[],
  skills: readonly SkillSummary[],
  resolved: readonly AgentSkill[],
  agentNames: AgentNames
): AssignedSkill[] => {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const resolvedById = new Map(resolved.map((entry) => [entry.skillId, entry]));
  return assignments.map((assignment) => {
    const entry = resolvedById.get(assignment.skillId);
    return {
      ...skillHeading(
        skillsById.get(assignment.skillId),
        assignment.skillId,
        agentNames
      ),
      pinned: entry?.pinned ?? false,
      pinnedVersion: assignment.pinnedVersion,
      skillId: assignment.skillId,
      version: entry?.version ?? null,
    };
  });
};

/** Skills an agent can take: approved at least once, and not carried yet. */
export const assignableSkills = (
  skills: readonly SkillSummary[],
  assignments: readonly SkillAssignment[]
): SkillSummary[] => {
  const carried = new Set(assignments.map((assignment) => assignment.skillId));
  return skills.filter(
    (skill) => skill.latestApprovedVersion !== null && !carried.has(skill.id)
  );
};

/** "name (owner)", the label of an assignable skill. */
export const assignLabel = (
  skill: SkillSummary,
  agentNames: AgentNames
): string => `${skill.name} (${ownerLabel(skill.ownerAgentId, agentNames)})`;

export interface AgentProposal extends SkillHeading {
  key: string;
  message: string;
  skillId: string;
  version: number;
}

/** The versions this agent proposed, joined with their skill's name and owner. */
export const agentProposals = (
  proposals: readonly SkillVersion[],
  skills: readonly SkillSummary[],
  agentId: string,
  agentNames: AgentNames
): AgentProposal[] => {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  return proposals
    .filter(
      (proposal) =>
        proposal.author.kind === "agent" && proposal.author.id === agentId
    )
    .map((proposal) => ({
      key: `${proposal.skillId}/${proposal.number}`,
      message: proposal.message,
      skillId: proposal.skillId,
      version: proposal.number,
      ...skillHeading(
        skillsById.get(proposal.skillId),
        proposal.skillId,
        agentNames
      ),
    }));
};

/** The approved version numbers of a skill, newest first. */
export const approvedVersions = (log: readonly SkillVersion[]): number[] =>
  log
    .filter((version) => version.status === "approved")
    .map((version) => version.number)
    .sort((a, b) => b - a);

/** The value of the pin select: "" follows the latest approved version. */
export const pinValue = (pinnedVersion: number | null): string =>
  pinnedVersion === null ? "" : String(pinnedVersion);

/** The pin to send for a select value. "" means follow the latest approved version. */
export const pinChoice = (value: string): number | null =>
  value === "" ? null : Number(value);
