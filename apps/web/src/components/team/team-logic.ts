import type {
  AgentAvatar,
  AgentCard,
  JobSentence,
  Team,
  TeamMemberKind,
  WorkspaceMember,
} from "@repo/db/shared";

/** What the team page needs of an agent: the roster card without its status. */
export type TeamAgent = Pick<AgentCard, "avatar" | "id" | "jobLine" | "name">;

/** A person of the workspace, as the member lookup returns them. */
export type TeamPerson = WorkspaceMember;

/** The most characters a team name or a person's name may have. Matches the service. */
export const NAME_MAX = 80;

/** The most characters team rules may have. Matches the service. */
export const RULES_MAX = 20_000;

// The handle rules restate `HANDLE_PATTERN`, `HANDLE_MIN` and `HANDLE_MAX` in
// `packages/services/src/teams.ts`, which the browser bundle cannot import
// because that file pulls in drizzle. `team-logic.test.ts` checks the two agree.
export const HANDLE_MIN = 2;
export const HANDLE_MAX = 40;
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEADING_AT = /^@+/;

export const UNKNOWN_AGENT = "Unknown agent";
export const UNKNOWN_PERSON = "Unknown person";

/** One line of the member list. */
export interface MemberRow {
  /** The agent's avatar, or null for a person. */
  avatar: AgentAvatar | null;
  /** The agent's job line. Empty for a person. */
  detail: string;
  id: string;
  isLead: boolean;
  isYou: boolean;
  kind: TeamMemberKind;
  label: string;
}

/** True for an org admin or the person who owns the team. */
export const canEditTeam = ({
  isAdmin,
  ownerUserId,
  userId,
}: {
  isAdmin: boolean;
  ownerUserId: string | null;
  userId: string | null | undefined;
}): boolean => isAdmin || (Boolean(userId) && userId === ownerUserId);

const byLabel = (a: { label: string }, b: { label: string }): number =>
  a.label.localeCompare(b.label);

/**
 * The team's members as rows: agents first, the lead at the top, then people by
 * name. A member the lookups no longer know keeps a row with a fallback label,
 * so it can still be removed.
 */
export const memberRows = (
  team: Pick<Team, "leadAgentId" | "members">,
  agents: readonly TeamAgent[],
  people: readonly TeamPerson[] | null,
  youId: string | null | undefined
): MemberRow[] => {
  const agentRows: MemberRow[] = [];
  const personRows: MemberRow[] = [];
  for (const member of team.members) {
    if (member.memberKind === "agent") {
      const agent = agents.find((entry) => entry.id === member.memberId);
      agentRows.push({
        avatar: agent?.avatar ?? null,
        detail: agent?.jobLine ?? "",
        id: member.memberId,
        isLead: team.leadAgentId === member.memberId,
        isYou: false,
        kind: "agent",
        label: agent?.name ?? UNKNOWN_AGENT,
      });
    } else {
      const person = people?.find((entry) => entry.userId === member.memberId);
      personRows.push({
        avatar: null,
        detail: "",
        id: member.memberId,
        isLead: false,
        isYou: member.memberId === youId,
        kind: "user",
        label: person?.name ?? UNKNOWN_PERSON,
      });
    }
  }
  agentRows.sort(
    (a, b) => Number(b.isLead) - Number(a.isLead) || byLabel(a, b)
  );
  personRows.sort(byLabel);
  return [...agentRows, ...personRows];
};

/** The agents that are not yet in the team, by name. */
export const addableAgents = (
  team: Pick<Team, "members">,
  agents: readonly TeamAgent[]
): TeamAgent[] => {
  const inTeam = new Set(
    team.members
      .filter((member) => member.memberKind === "agent")
      .map((member) => member.memberId)
  );
  return agents
    .filter((agent) => !inTeam.has(agent.id))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** The people that are not yet in the team, by name. Empty when the lookup failed. */
export const addablePeople = (
  team: Pick<Team, "members">,
  people: readonly TeamPerson[] | null
): TeamPerson[] => {
  const inTeam = new Set(
    team.members
      .filter((member) => member.memberKind === "user")
      .map((member) => member.memberId)
  );
  return (people ?? [])
    .filter((person) => !inTeam.has(person.userId))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** The agents that may lead: the team's agent members, by name. */
export const leadChoices = (
  team: Pick<Team, "members">,
  agents: readonly TeamAgent[]
): { id: string; label: string }[] =>
  team.members
    .filter((member) => member.memberKind === "agent")
    .map((member) => ({
      id: member.memberId,
      label:
        agents.find((agent) => agent.id === member.memberId)?.name ??
        UNKNOWN_AGENT,
    }))
    .sort(byLabel);

/** The jobs that are on and belong to an agent of the team. */
export const teamJobs = (
  jobs: readonly JobSentence[],
  team: Pick<Team, "members">
): JobSentence[] => {
  const agentIds = new Set(
    team.members
      .filter((member) => member.memberKind === "agent")
      .map((member) => member.memberId)
  );
  return jobs.filter(
    (job) => job.enabled && !job.awaitingApproval && agentIds.has(job.agent.id)
  );
};

/** A handle as typed: no spaces around it, no leading @, lowercase. */
export const normalizeHandle = (raw: string): string =>
  raw.trim().replace(LEADING_AT, "").toLowerCase();

/** Why a handle is not valid, or null. Pass the normalised handle. */
export const handleError = (handle: string): string | null => {
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    return `A handle is ${HANDLE_MIN} to ${HANDLE_MAX} characters.`;
  }
  if (!HANDLE_PATTERN.test(handle)) {
    return "Use lowercase letters and digits, with single hyphens between them.";
  }
  return null;
};

/** Why a name is not valid, or null. */
export const nameError = (name: string): string | null => {
  const trimmed = name.trim();
  if (trimmed === "") {
    return "Enter a name.";
  }
  return trimmed.length > NAME_MAX
    ? `A name is at most ${NAME_MAX} characters.`
    : null;
};

/** The two `teams` calls a new team needs. */
export interface TeamsWriteApi {
  addMember: (input: {
    isHome: false;
    memberId: string;
    memberKind: TeamMemberKind;
    teamId: string;
  }) => Promise<unknown>;
  create: (input: {
    leadAgentId: string | null;
    name: string;
  }) => Promise<Pick<Team, "id" | "name">>;
}

export interface NewTeamInput {
  /** Agents to add. The lead joins on its own and may be left out. */
  agentIds: readonly string[];
  leadAgentId: string | null;
  name: string;
  personIds: readonly string[];
}

export interface NewTeamResult {
  /** Members that could not be added, with the reason. */
  failed: { id: string; reason: string }[];
  team: Pick<Team, "id" | "name">;
}

/**
 * Creates the team, then adds each member. `create` takes no
 * members, and the lead joins by itself. A member that cannot be added does not
 * undo the team: it comes back in `failed`, so the caller can open the team and
 * say what is missing. A failed `create` throws.
 */
export const createTeamWithMembers = async (
  api: TeamsWriteApi,
  input: NewTeamInput
): Promise<NewTeamResult> => {
  const team = await api.create({
    leadAgentId: input.leadAgentId,
    name: input.name.trim(),
  });
  const members: { id: string; kind: TeamMemberKind }[] = [
    ...input.agentIds
      .filter((id) => id !== input.leadAgentId)
      .map((id) => ({ id, kind: "agent" as const })),
    ...input.personIds.map((id) => ({ id, kind: "user" as const })),
  ];
  const results = await Promise.all(
    members.map(async (member) => {
      try {
        await api.addMember({
          isHome: false,
          memberId: member.id,
          memberKind: member.kind,
          teamId: team.id,
        });
        return null;
      } catch (error) {
        return {
          id: member.id,
          reason: error instanceof Error ? error.message : "Could not add.",
        };
      }
    })
  );
  const failed = results.filter((result) => result !== null);
  return { failed, team };
};
