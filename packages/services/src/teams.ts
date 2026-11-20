import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentLibraryAccess, libraryEntries } from "@repo/db/schema/library";
import { teamSlackLinks } from "@repo/db/schema/slack";
import { memberProfiles, teamMembers, teams } from "@repo/db/schema/teams";
import {
  EVERYONE_TEAM_SLUG,
  type MemberProfile,
  TEAM_MEMBER_KINDS,
  type Team,
  type TeamMember,
  type TeamSlackChannels,
  type TeamSlackLink,
  type TeamSlackStatus,
} from "@repo/db/shared";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { slugify, slugSchema } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import { readableWorkspace, requireUser } from "./guards.ts";
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

/** `slug` defaults to the name as a slug; a supplied lead joins immediately. */
export const teamCreateInputSchema = z.strictObject({
  leadAgentId: idString.nullable().default(null),
  leadListens: z.boolean().default(true),
  name: nameSchema,
  /** Defaults to the person who creates the team. */
  ownerUserId: idString.nullable().optional(),
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

/** Links the team's room to one Slack channel. Fails when the team or the channel is already linked. */
export const slackLinkInputSchema = z.strictObject({
  channelId: idString,
  slackTeamId: idString,
  teamId: idString,
});

export type SlackLinkInput = z.input<typeof slackLinkInputSchema>;
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
  /** The Slack side of linking: the channels the lead's app can see, and whether a member app may post in one (`slack/room-channels.ts`). */
  slackChannels: {
    canPost: (
      workspaceId: string,
      teamId: string,
      slackTeamId: string,
      channelId: string
    ) => Promise<boolean>;
    list: (workspaceId: string, teamId: string) => Promise<TeamSlackChannels>;
  };
  /** Which member agents have their Slack app in the team's linked channel (`slack/room-status.ts`). */
  slackStatus: (
    workspaceId: string,
    teamId: string
  ) => Promise<TeamSlackStatus>;
}

const teamResource = (workspaceId: string, id?: string) => ({
  id,
  kind: TEAMS_KIND,
  workspaceId,
});

type TeamRow = typeof teams.$inferSelect;

const memberShape = ({
  workspaceId: _workspaceId,
  ...row
}: typeof teamMembers.$inferSelect): TeamMember => row;
const profileShape = ({
  workspaceId: _workspaceId,
  ...row
}: typeof memberProfiles.$inferSelect): MemberProfile => row;

const person = (principal: Principal, write = false) => {
  const user = requireUser(principal, write ? TEAMS_WRITE : TEAMS_READ);
  const action = write ? TEAMS_WRITE : TEAMS_READ;
  const workspaceId = readableWorkspace(user, action);
  authorize(user, action, teamResource(workspaceId));
  if (
    write &&
    (user.apiKey?.access === "read" || user.oauthClient?.access === "read")
  ) {
    throw new ForbiddenError(action);
  }
  return user;
};

const requireOwner = (
  user: ReturnType<typeof person>,
  ownerUserId: string | null
) => {
  if (user.isAdmin !== true && user.userId !== ownerUserId) {
    throw new ForbiddenError(TEAMS_WRITE);
  }
};

const uniqueWrite = async (write: () => Promise<void>, message: string) => {
  try {
    await write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw Object.assign(new ServiceError("conflict", message), {
        cause: error,
      });
    }
    throw error;
  }
};

export const createTeamsService = ({
  db,
  atomic,
  clock,
  slackChannels,
  slackStatus: readSlackStatus,
}: TeamsDeps) => {
  const teamRow = async (workspaceId: string, teamId: string) => {
    const [row] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, teamId)));
    if (!row) {
      throw new ServiceError("not_found", `No team "${teamId}"`);
    }
    return row;
  };

  const withMembers = async (rows: TeamRow[]): Promise<Team[]> => {
    const [first] = rows;
    if (!first) {
      return [];
    }
    const members = await db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.workspaceId, first.workspaceId),
          inArray(
            teamMembers.teamId,
            rows.map((row) => row.id)
          )
        )
      )
      .orderBy(asc(teamMembers.memberKind), asc(teamMembers.memberId));
    return rows.map(({ workspaceId: _workspaceId, ...row }) => ({
      ...row,
      members: members
        .filter((member) => member.teamId === row.id)
        .map(memberShape),
    }));
  };

  const get = async (principal: Principal, teamId: string): Promise<Team> => {
    const user = person(principal);
    const [team] = await withMembers([await teamRow(user.workspaceId, teamId)]);
    if (!team) {
      throw new ServiceError("not_found", "Team not found");
    }
    return team;
  };

  const list = async (principal: Principal): Promise<Team[]> => {
    const user = person(principal);
    return withMembers(
      await db
        .select()
        .from(teams)
        .where(
          and(eq(teams.workspaceId, user.workspaceId), isNull(teams.archivedAt))
        )
        .orderBy(asc(teams.name), asc(teams.id))
    );
  };

  const writableTeam = async (
    principal: Principal,
    teamId: string,
    allowArchived = false
  ) => {
    const user = person(principal, true);
    const row = await teamRow(user.workspaceId, teamId);
    requireOwner(user, row.ownerUserId);
    if (row.archivedAt && !allowArchived) {
      throw new ServiceError("invalid", "Team is archived");
    }
    return row;
  };

  const activeAgent = async (workspaceId: string, agentId: string) => {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.id, agentId),
          eq(agents.status, "active")
        )
      );
    if (!agent) {
      throw new ServiceError(
        "invalid",
        "Agent must be active in this workspace"
      );
    }
  };

  const memberRef = (input: TeamMemberRefInput) =>
    and(
      eq(teamMembers.teamId, input.teamId),
      eq(teamMembers.memberKind, input.memberKind),
      eq(teamMembers.memberId, input.memberId)
    );

  const grantStatement = (team: TeamRow, agentId: string, path: string) =>
    db
      .insert(agentLibraryAccess)
      .values({
        agentId,
        createdAt: clock.now().toISOString(),
        mode: "write",
        path,
        workspaceId: team.workspaceId,
      })
      .onConflictDoUpdate({
        set: { mode: "write" },
        target: [agentLibraryAccess.agentId, agentLibraryAccess.path],
      });

  const membershipStatements = (
    team: TeamRow,
    input: z.output<typeof teamMemberInputSchema>
  ): Statement[] => {
    const statements: Statement[] = [];
    const agent = input.memberKind === "agent";
    if (agent && input.isHome) {
      statements.push(
        db
          .update(teamMembers)
          .set({ isHome: false })
          .where(
            and(
              eq(teamMembers.memberKind, "agent"),
              eq(teamMembers.memberId, input.memberId)
            )
          )
      );
    }
    // Evaluate the first-home rule inside the atomic write, including concurrent joins.
    const isHome = agent
      ? sql<boolean>`not exists (
      select 1 from team_members where member_kind = 'agent'
      and member_id = ${input.memberId} and is_home = 1
      and team_id != ${team.id}
    )`
      : false;
    statements.push(
      db
        .insert(teamMembers)
        .values({
          ...input,
          isHome,
          workspaceId: team.workspaceId,
        })
        .onConflictDoUpdate({
          set: { isHome },
          target: [
            teamMembers.teamId,
            teamMembers.memberKind,
            teamMembers.memberId,
          ],
        })
    );
    if (agent && team.folderPath) {
      statements.push(grantStatement(team, input.memberId, team.folderPath));
    }
    return statements;
  };

  const folders = async (
    user: ReturnType<typeof person>,
    folderPath: string
  ): Promise<Statement[]> => {
    const paths = ["teams", folderPath];
    const existing = await db
      .select()
      .from(libraryEntries)
      .where(
        and(
          eq(libraryEntries.workspaceId, user.workspaceId),
          inArray(libraryEntries.path, paths)
        )
      );
    // Like library.mkdir, a file occupying either folder path is invalid.
    if (existing.some((row) => row.kind !== "dir")) {
      throw new ServiceError(
        "invalid",
        "A file is in the way of the team folder"
      );
    }
    return paths.map((path) =>
      db
        .insert(libraryEntries)
        .values({
          etag: null,
          kind: "dir",
          mtime: clock.now().toISOString(),
          parent: path === "teams" ? "" : "teams",
          path,
          size: 0,
          updatedById: user.userId,
          updatedByKind: "user",
          workspaceId: user.workspaceId,
        })
        .onConflictDoNothing()
    );
  };

  const create = async (
    principal: Principal,
    raw: TeamCreateInput
  ): Promise<Team> => {
    const user = person(principal, true);
    const input = teamCreateInputSchema.parse(raw);
    // An explicit null means no owner; only admins can create an ownerless team.
    const ownerUserId =
      input.ownerUserId === undefined ? user.userId : input.ownerUserId;
    requireOwner(user, ownerUserId);
    const slug = input.slug ?? slugify(input.name);
    // Names that cannot form a valid slug require an explicit slug, as agents do.
    if (!slugSchema.safeParse(slug).success) {
      throw new ServiceError("invalid", "Name needs an explicit valid slug");
    }
    const [used] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.workspaceId, user.workspaceId), eq(teams.slug, slug))
      );
    if (used) {
      throw new ServiceError("conflict", "Team slug is already used");
    }
    if (input.leadAgentId) {
      await activeAgent(user.workspaceId, input.leadAgentId);
    }
    const row: TeamRow = {
      ...input,
      archivedAt: null,
      createdAt: clock.now().toISOString(),
      folderPath: slug === EVERYONE_TEAM_SLUG ? null : `teams/${slug}`,
      id: ulid(),
      ownerUserId,
      slug,
      workspaceId: user.workspaceId,
    };
    const statements: Statement[] = [db.insert(teams).values(row)];
    if (row.folderPath) {
      statements.push(...(await folders(user, row.folderPath)));
    }
    if (row.leadAgentId) {
      statements.push(
        ...membershipStatements(row, {
          isHome: false,
          memberId: row.leadAgentId,
          memberKind: "agent",
          teamId: row.id,
        })
      );
    }
    await uniqueWrite(() => atomic(statements), "Team slug is already used");
    return get(user, row.id);
  };

  const update = async (
    principal: Principal,
    raw: TeamUpdateInput
  ): Promise<Team> => {
    const { teamId, ...changes } = teamUpdateInputSchema.parse(raw);
    await writableTeam(principal, teamId);
    if (Object.keys(changes).length) {
      await atomic([db.update(teams).set(changes).where(eq(teams.id, teamId))]);
    }
    return get(principal, teamId);
  };

  const archive = async (
    principal: Principal,
    teamId: string
  ): Promise<Team> => {
    const row = await writableTeam(principal, teamId, true);
    if (row.slug === EVERYONE_TEAM_SLUG) {
      throw new ServiceError("invalid", "Everyone cannot be archived");
    }
    await atomic([
      db
        .update(teams)
        .set({ archivedAt: clock.now().toISOString() })
        .where(and(eq(teams.id, teamId), isNull(teams.archivedAt))),
    ]);
    return get(principal, teamId);
  };

  const addMember = async (
    principal: Principal,
    raw: TeamMemberInput
  ): Promise<TeamMember> => {
    const input = teamMemberInputSchema.parse(raw);
    const row = await writableTeam(principal, input.teamId);
    if (input.memberKind === "agent") {
      await activeAgent(row.workspaceId, input.memberId);
    }
    await atomic(membershipStatements(row, input));
    const [member] = await db
      .select()
      .from(teamMembers)
      .where(memberRef(input));
    if (!member) {
      throw new ServiceError("not_found", "Team member not found");
    }
    return memberShape(member);
  };

  const promoteHome = (input: TeamMemberRefInput): Statement =>
    db
      .update(teamMembers)
      .set({ isHome: true })
      .where(
        and(
          eq(teamMembers.memberKind, "agent"),
          eq(teamMembers.memberId, input.memberId),
          sql`not exists (select 1 from team_members where member_kind = 'agent'
        and member_id = ${input.memberId} and is_home = 1)`,
          eq(
            teamMembers.teamId,
            sql`(select tm.team_id from team_members tm
        join teams t on t.id = tm.team_id where tm.member_kind = 'agent'
        and tm.member_id = ${input.memberId}
        order by (t.archived_at is not null), t.id limit 1)`
          )
        )
      );

  const removeMember = async (
    principal: Principal,
    raw: TeamMemberRefInput
  ): Promise<Team> => {
    const input = teamMemberRefInputSchema.parse(raw);
    // An archived team still lets its members go, so their folder grants can be revoked.
    const row = await writableTeam(principal, input.teamId, true);
    const [member] = await db
      .select()
      .from(teamMembers)
      .where(memberRef(input));
    if (!member) {
      throw new ServiceError("not_found", "Team member not found");
    }
    const statements: Statement[] = [
      db.delete(teamMembers).where(memberRef(input)),
    ];
    if (input.memberKind === "agent") {
      statements.push(promoteHome(input));
      if (row.folderPath) {
        statements.push(
          db
            .delete(agentLibraryAccess)
            .where(
              and(
                eq(agentLibraryAccess.agentId, input.memberId),
                eq(agentLibraryAccess.path, row.folderPath),
                eq(agentLibraryAccess.workspaceId, row.workspaceId)
              )
            )
        );
      }
      statements.push(
        db
          .update(teams)
          .set({ leadAgentId: null })
          .where(
            and(eq(teams.id, row.id), eq(teams.leadAgentId, input.memberId))
          )
      );
    }
    await atomic(statements);
    return get(principal, row.id);
  };

  const setLead = async (
    principal: Principal,
    raw: SetLeadInput
  ): Promise<Team> => {
    const input = setLeadInputSchema.parse(raw);
    await writableTeam(principal, input.teamId);
    if (input.agentId !== null) {
      const [member] = await db
        .select()
        .from(teamMembers)
        .where(
          memberRef({
            memberId: input.agentId,
            memberKind: "agent",
            teamId: input.teamId,
          })
        );
      if (!member) {
        throw new ServiceError("invalid", "Lead must be an agent member");
      }
    }
    await atomic([
      db
        .update(teams)
        .set({ leadAgentId: input.agentId })
        .where(eq(teams.id, input.teamId)),
    ]);
    return get(principal, input.teamId);
  };

  const setRules = async (
    principal: Principal,
    raw: SetRulesInput
  ): Promise<Team> => {
    const input = setRulesInputSchema.parse(raw);
    await writableTeam(principal, input.teamId);
    await atomic([
      db
        .update(teams)
        .set({ rules: input.rules })
        .where(eq(teams.id, input.teamId)),
    ]);
    return get(principal, input.teamId);
  };

  const slackChannelList = async (
    principal: Principal,
    teamId: string
  ): Promise<TeamSlackChannels> => {
    const row = await writableTeam(principal, teamId);
    return slackChannels.list(row.workspaceId, teamId);
  };

  const linkSlack = async (
    principal: Principal,
    raw: SlackLinkInput
  ): Promise<TeamSlackLink> => {
    const input = slackLinkInputSchema.parse(raw);
    const row = await writableTeam(principal, input.teamId);
    const user = person(principal, true);
    const [taken] = await db
      .select({ teamId: teamSlackLinks.teamId })
      .from(teamSlackLinks)
      .where(
        or(
          eq(teamSlackLinks.teamId, input.teamId),
          and(
            eq(teamSlackLinks.slackTeamId, input.slackTeamId),
            eq(teamSlackLinks.channelId, input.channelId)
          )
        )
      );
    if (taken) {
      throw new ServiceError(
        "conflict",
        taken.teamId === input.teamId
          ? "This team is already linked to a Slack channel. Unlink it first."
          : "That Slack channel is linked to another team."
      );
    }
    const canPost = await slackChannels.canPost(
      row.workspaceId,
      input.teamId,
      input.slackTeamId,
      input.channelId
    );
    if (!canPost) {
      throw new ServiceError(
        "invalid",
        "No agent of this team has its Slack app in that channel."
      );
    }
    const link: TeamSlackLink = {
      channelId: input.channelId,
      createdAt: clock.now().toISOString(),
      linkedBy: user.userId,
      slackTeamId: input.slackTeamId,
      teamId: input.teamId,
    };
    await uniqueWrite(
      () =>
        atomic([
          db
            .insert(teamSlackLinks)
            .values({ ...link, id: ulid(), workspaceId: row.workspaceId }),
        ]),
      "That Slack channel is linked to another team."
    );
    return link;
  };

  const unlinkSlack = async (
    principal: Principal,
    teamId: string
  ): Promise<void> => {
    // An archived team can still be unlinked.
    await writableTeam(principal, teamId, true);
    await atomic([
      db.delete(teamSlackLinks).where(eq(teamSlackLinks.teamId, teamId)),
    ]);
  };

  const slackStatus = (
    principal: Principal,
    teamId: string
  ): Promise<TeamSlackStatus> => {
    const workspaceId = readableWorkspace(principal, TEAMS_READ);
    authorize(principal, TEAMS_READ, teamResource(workspaceId, teamId));
    return teamRow(workspaceId, teamId).then(() =>
      readSlackStatus(workspaceId, teamId)
    );
  };

  const getProfile = async (
    principal: Principal,
    raw: ProfileGetInput
  ): Promise<MemberProfile | null> => {
    const user = person(principal);
    const input = profileGetInputSchema.parse(raw);
    const [row] = await db
      .select()
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.workspaceId, user.workspaceId),
          eq(memberProfiles.userId, input.userId ?? user.userId)
        )
      );
    return row ? profileShape(row) : null;
  };

  const setProfile = async (
    principal: Principal,
    raw: ProfileSetInput
  ): Promise<MemberProfile> => {
    const user = person(principal, true);
    const input = profileSetInputSchema.parse(raw);
    const [used] = await db
      .select()
      .from(memberProfiles)
      .where(
        and(
          eq(memberProfiles.workspaceId, user.workspaceId),
          eq(memberProfiles.handle, input.handle),
          ne(memberProfiles.userId, user.userId)
        )
      );
    if (used) {
      throw new ServiceError("conflict", "Handle is already used");
    }
    await uniqueWrite(
      () =>
        atomic([
          db
            .insert(memberProfiles)
            .values({
              ...input,
              userId: user.userId,
              workspaceId: user.workspaceId,
            })
            .onConflictDoUpdate({
              set: input,
              target: [memberProfiles.workspaceId, memberProfiles.userId],
            }),
        ]),
      "Handle is already used"
    );
    return { ...input, userId: user.userId };
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
    slack: {
      channels: slackChannelList,
      link: linkSlack,
      status: slackStatus,
      unlink: unlinkSlack,
    },
    update,
  };
};

export type TeamsService = ReturnType<typeof createTeamsService>;
