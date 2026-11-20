/**
 * Who may read and post in a topic of a team room. A topic with no member
 * rows is open to its whole team. A topic with member rows is limited to
 * those members. A person and an agent are told apart by `kind`, so a user
 * and an agent with the same id string are different roomers.
 */

import type { Database } from "@repo/db";
import { inboxThreadMembers, inboxThreads } from "@repo/db/schema/inbox";
import { sessions } from "@repo/db/schema/sessions";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { EVERYONE_TEAM_SLUG, type TeamMemberKind } from "@repo/db/shared";
import { and, eq, type SQL, sql } from "drizzle-orm";

export interface Roomer {
  id: string;
  kind: TeamMemberKind;
}

export interface RoomThread {
  id: string;
  teamId: string | null;
}

const isMatchingRoomer = (
  member: { memberId: string; memberKind: TeamMemberKind },
  roomer: Roomer
): boolean =>
  member.memberKind === roomer.kind && member.memberId === roomer.id;

export const canReadTopic = async (
  db: Database,
  thread: RoomThread,
  roomer: Roomer
): Promise<boolean> => {
  const members = await db
    .select({
      memberId: inboxThreadMembers.memberId,
      memberKind: inboxThreadMembers.memberKind,
    })
    .from(inboxThreadMembers)
    .where(eq(inboxThreadMembers.threadId, thread.id));
  if (members.length === 0) {
    return true;
  }
  return members.some((member) => isMatchingRoomer(member, roomer));
};

/** True when the roomer is in the team. A topic with no team is open to everyone. */
export const isInTeam = async (
  db: Database,
  teamId: string | null,
  roomer: Roomer
): Promise<boolean> => {
  if (teamId === null) {
    return true;
  }
  const [team] = await db
    .select({ slug: teams.slug })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!team) {
    return false;
  }
  // The Everyone team has no member rows: every workspace member is in it.
  if (team.slug === EVERYONE_TEAM_SLUG) {
    return true;
  }
  const [membership] = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.memberKind, roomer.kind),
        eq(teamMembers.memberId, roomer.id)
      )
    );
  return membership !== undefined;
};

export const canPostInTopic = async (
  db: Database,
  thread: RoomThread,
  roomer: Roomer
): Promise<boolean> => {
  if (!(await canReadTopic(db, thread, roomer))) {
    return false;
  }
  return isInTeam(db, thread.teamId, roomer);
};

/**
 * A WHERE clause over `inboxThreads` that keeps the topics `canReadTopic`
 * allows this roomer: those with no member rows, and those with a row for
 * the roomer. The per-thread match stays in SQL, so the only bound values
 * are the roomer's kind and id.
 */
export const topicVisibleTo = (roomer: Roomer): SQL => sql`(
  not exists (
    select 1 from ${inboxThreadMembers}
    where ${inboxThreadMembers.threadId} = ${inboxThreads.id}
  )
  or exists (
    select 1 from ${inboxThreadMembers}
    where ${inboxThreadMembers.threadId} = ${inboxThreads.id}
      and ${inboxThreadMembers.memberKind} = ${roomer.kind}
      and ${inboxThreadMembers.memberId} = ${roomer.id}
  )
)`;

/**
 * A WHERE clause over `sessions` that hides the inbox session of a limited
 * topic (its `external_key` is the thread id) from everyone not in the topic.
 * Every other session passes.
 */
export const inboxSessionVisibleTo = (roomer: Roomer): SQL => sql`(
  ${sessions.origin} <> 'inbox'
  or not exists (
    select 1 from ${inboxThreadMembers}
    where ${inboxThreadMembers.threadId} = ${sessions.externalKey}
  )
  or exists (
    select 1 from ${inboxThreadMembers}
    where ${inboxThreadMembers.threadId} = ${sessions.externalKey}
      and ${inboxThreadMembers.memberKind} = ${roomer.kind}
      and ${inboxThreadMembers.memberId} = ${roomer.id}
  )
)`;
