import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  type MemberProfile,
  TEAM_MEMBER_KINDS,
  type Team,
  type TeamMember,
} from "@repo/db/shared";
import { z } from "zod";
import { slugSchema } from "./agents.ts";
import { authorize } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { readableWorkspace } from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import { idString } from "./shared.ts";
import type { Principal } from "./workspaces.ts";

const TEAMS_READ = "teams.read";
const TEAMS_WRITE = "teams.write";
const TEAMS_KIND = "team";

const NAME_MAX = 80;
const RULES_MAX = 20_000;
const HANDLE_MIN = 2;
const HANDLE_MAX = 40;
// Lowercase letters and digits with single hyphens between them, so an
// `@handle` parses the way `@slug` does in `inbox/mentions.ts`.
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const nameSchema = z.string().trim().min(1).max(NAME_MAX);
const rulesSchema = z.string().max(RULES_MAX);
const memberKindSchema = z.enum(TEAM_MEMBER_KINDS);
const handleSchema = z
  .string()
  .min(HANDLE_MIN)
  .max(HANDLE_MAX)
  .regex(HANDLE_PATTERN);

export const teamIdInputSchema = z.strictObject({ teamId: idString });

/** `slug` defaults to the name as a slug. A new team has no members until `addMember`. */
export const teamCreateInputSchema = z.strictObject({
  leadAgentId: idString.nullable().default(null),
  leadListens: z.boolean().default(true),
  name: nameSchema,
  rules: rulesSchema.default(""),
  slug: slugSchema.optional(),
});

/** Only the fields present change. The lead and the rules have their own calls. */
export const teamUpdateInputSchema = z.strictObject({
  leadListens: z.boolean().optional(),
  name: nameSchema.optional(),
  ownerUserId: idString.nullable().optional(),
  teamId: idString,
});

export const teamMemberInputSchema = z.strictObject({
  isHome: z.boolean().default(false),
  memberId: idString,
  memberKind: memberKindSchema,
  teamId: idString,
});

export const teamMemberRefInputSchema = z.strictObject({
  memberId: idString,
  memberKind: memberKindSchema,
  teamId: idString,
});

/** `agentId: null` leaves the team with no lead. */
export const setLeadInputSchema = z.strictObject({
  agentId: idString.nullable(),
  teamId: idString,
});

export const setRulesInputSchema = z.strictObject({
  rules: rulesSchema,
  teamId: idString,
});

/** No `userId` reads the caller's own profile. */
export const profileGetInputSchema = z.strictObject({
  userId: idString.optional(),
});

/** Sets the caller's own profile. */
export const profileSetInputSchema = z.strictObject({
  handle: handleSchema,
  name: nameSchema,
});

export type TeamCreateInput = z.input<typeof teamCreateInputSchema>;
export type TeamUpdateInput = z.input<typeof teamUpdateInputSchema>;
export type TeamMemberInput = z.input<typeof teamMemberInputSchema>;
export type TeamMemberRefInput = z.input<typeof teamMemberRefInputSchema>;
export type SetLeadInput = z.input<typeof setLeadInputSchema>;
export type SetRulesInput = z.input<typeof setRulesInputSchema>;
export type ProfileGetInput = z.input<typeof profileGetInputSchema>;
export type ProfileSetInput = z.input<typeof profileSetInputSchema>;

export interface TeamsDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
}

const teamResource = (workspaceId: string, id?: string) => ({
  id,
  kind: TEAMS_KIND,
  workspaceId,
});

const noTeam = (teamId: string) =>
  Promise.reject(new ServiceError("not_found", `No team "${teamId}"`));

/**
 * Stub: no team is listed, and a read or a change finds no team. The teams
 * service task fills these from the `teams`, `team_members` and
 * `member_profiles` tables. It takes the dependencies it will need, so wiring
 * it in `compose.ts` is already final.
 */
export const createTeamsService = (_deps: TeamsDeps) => {
  const list = (principal: Principal): Promise<Team[]> => {
    const workspaceId = readableWorkspace(principal, TEAMS_READ);
    authorize(principal, TEAMS_READ, teamResource(workspaceId));
    return Promise.resolve([]);
  };

  const get = (principal: Principal, teamId: string): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_READ);
    authorize(principal, TEAMS_READ, teamResource(workspaceId, teamId));
    return noTeam(teamId);
  };

  const create = (
    principal: Principal,
    _input: TeamCreateInput
  ): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId));
    return Promise.reject(new ServiceError("not_found", "No team was created"));
  };

  const update = (
    principal: Principal,
    input: TeamUpdateInput
  ): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId, input.teamId));
    return noTeam(input.teamId);
  };

  const archive = (principal: Principal, teamId: string): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId, teamId));
    return noTeam(teamId);
  };

  const addMember = (
    principal: Principal,
    input: TeamMemberInput
  ): Promise<TeamMember> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId, input.teamId));
    return noTeam(input.teamId);
  };

  const removeMember = (
    principal: Principal,
    input: TeamMemberRefInput
  ): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId, input.teamId));
    return noTeam(input.teamId);
  };

  const setLead = (
    principal: Principal,
    input: SetLeadInput
  ): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId, input.teamId));
    return noTeam(input.teamId);
  };

  const setRules = (
    principal: Principal,
    input: SetRulesInput
  ): Promise<Team> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId, input.teamId));
    return noTeam(input.teamId);
  };

  const getProfile = (
    principal: Principal,
    _input: ProfileGetInput
  ): Promise<MemberProfile | null> => {
    const workspaceId = readableWorkspace(principal, TEAMS_READ);
    authorize(principal, TEAMS_READ, teamResource(workspaceId));
    return Promise.resolve(null);
  };

  const setProfile = (
    principal: Principal,
    _input: ProfileSetInput
  ): Promise<MemberProfile> => {
    const workspaceId = readableWorkspace(principal, TEAMS_WRITE);
    authorize(principal, TEAMS_WRITE, teamResource(workspaceId));
    return Promise.reject(new ServiceError("not_found", "No profile was set"));
  };

  return {
    addMember,
    archive,
    create,
    get,
    list,
    profiles: { get: getProfile, set: setProfile },
    removeMember,
    setLead,
    setRules,
    update,
  };
};

export type TeamsService = ReturnType<typeof createTeamsService>;
