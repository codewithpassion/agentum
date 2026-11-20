// The team a dream is about, its agent members, and the principal it works as.
// A team dream reads only the members that share with the team, and only their
// shared note files. It never holds the `dream` flag, so the library refuses
// every `private/` file at its own door (`library/memory-paths.ts`).
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DEFAULT_NEVER_REMEMBER,
  DEFAULT_REMEMBER_RULES,
  type MemoryNote,
} from "@repo/db/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { notFound, ServiceError } from "../../errors.ts";
import { effectiveOwner } from "../../guards.ts";
import { rememberRulesSchema } from "../../memory/service.ts";
import type { Principal } from "../../workspaces.ts";

export interface TeamInfo {
  folderPath: string;
  id: string;
  /** The agent that leads the team, when it has one and that agent is active. */
  leadAgentId: string | null;
  name: string;
  /** Clerk user id of the person who answers for the team. */
  ownerUserId: string | null;
  slug: string;
  workspaceId: string;
}

export interface TeamMember {
  id: string;
  name: string;
  /** Who answers for the agent. */
  ownerUserId: string;
  slug: string;
}

const parseJson = (raw: string | undefined): unknown => {
  try {
    return JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
};

/** The workspace's never list, the defaults when the column holds something else. */
export const neverListOf = (raw: string | undefined): string[] => {
  const parsed = z.array(z.string()).safeParse(parseJson(raw));
  return parsed.success ? parsed.data : [...DEFAULT_NEVER_REMEMBER];
};

/**
 * The team a dream is about. Refuses an archived team and one with no library
 * folder (the Everyone team), which has nowhere to keep team memory.
 */
export const loadTeamInfo = async (
  db: Database,
  teamId: string,
  workspaceId?: string
): Promise<TeamInfo> => {
  const [row] = await db
    .select({
      archivedAt: teams.archivedAt,
      folderPath: teams.folderPath,
      id: teams.id,
      leadAgentId: teams.leadAgentId,
      name: teams.name,
      ownerUserId: teams.ownerUserId,
      slug: teams.slug,
      workspaceId: teams.workspaceId,
    })
    .from(teams)
    .where(
      and(
        eq(teams.id, teamId),
        workspaceId === undefined
          ? undefined
          : eq(teams.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!row) {
    throw notFound(`No team "${teamId}"`);
  }
  if (row.archivedAt !== null) {
    throw new ServiceError(
      "conflict",
      `${row.name} is archived, so it does not dream`
    );
  }
  if (row.folderPath === null) {
    throw new ServiceError(
      "invalid",
      `${row.name} has no team folder, so it keeps no team memory and does not dream`
    );
  }
  const [lead] =
    row.leadAgentId === null
      ? []
      : await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, row.leadAgentId),
              eq(agents.workspaceId, row.workspaceId),
              eq(agents.status, "active")
            )
          )
          .limit(1);
  return {
    folderPath: row.folderPath,
    id: row.id,
    leadAgentId: lead?.id ?? null,
    name: row.name,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    workspaceId: row.workspaceId,
  };
};

const shares = (remember: string): boolean => {
  const parsed = rememberRulesSchema.safeParse(parseJson(remember));
  return (parsed.success ? parsed.data : DEFAULT_REMEMBER_RULES).shareWithTeam;
};

/**
 * The agent members of the team whose owners let the team dream read their
 * notes (`shareWithTeam`), in id order. An agent that does not share is not
 * returned, so nothing of it is read.
 */
export const loadSharingMembers = async (
  db: Database,
  team: Pick<TeamInfo, "id" | "workspaceId">
): Promise<TeamMember[]> => {
  const rows = await db
    .select({
      createdBy: agents.createdBy,
      id: agents.id,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      remember: agents.remember,
      slug: agents.slug,
    })
    .from(teamMembers)
    .innerJoin(agents, eq(agents.id, teamMembers.memberId))
    .where(
      and(
        eq(teamMembers.teamId, team.id),
        eq(teamMembers.memberKind, "agent"),
        eq(agents.workspaceId, team.workspaceId),
        eq(agents.status, "active")
      )
    )
    .orderBy(asc(agents.id));
  return rows
    .filter((row) => shares(row.remember))
    .map((row) => ({
      id: row.id,
      name: row.name,
      ownerUserId: effectiveOwner(row),
      slug: row.slug,
    }));
};

/** The workspace's never list. */
export const loadWorkspaceNever = async (
  db: Database,
  workspaceId: string
): Promise<string[]> => {
  const [row] = await db
    .select({ never: workspaces.neverRemember })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return neverListOf(row?.never);
};

/**
 * The principal a team dream reads and writes the library as. It has the shape
 * of a person and is named for the team. It does not carry `dream: true`, so
 * the library never lets it read a person's private memory file.
 */
export const teamDreamPrincipal = (team: {
  id: string;
  workspaceId: string;
}): Extract<Principal, { kind: "user" }> => ({
  kind: "user",
  userId: `dream:team:${team.id}`,
  via: "session",
  workspaceId: team.workspaceId,
});

/** A team as a person who answers for it sees it, archived or not, with or without a folder. */
export interface TeamRecord {
  archivedAt: string | null;
  folderPath: string | null;
  id: string;
  name: string;
  ownerUserId: string | null;
  workspaceId: string;
}

/** The team row, for deciding who may answer, undo or start its dream. */
export const loadTeamRecord = async (
  db: Database,
  teamId: string,
  workspaceId: string
): Promise<TeamRecord> => {
  const [row] = await db
    .select({
      archivedAt: teams.archivedAt,
      folderPath: teams.folderPath,
      id: teams.id,
      name: teams.name,
      ownerUserId: teams.ownerUserId,
      workspaceId: teams.workspaceId,
    })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
    .limit(1);
  if (!row) {
    throw notFound(`No team "${teamId}"`);
  }
  return row;
};

/** The `source_id` and `source_kind` columns of a note's source. */
export const sourceColumns = (source: MemoryNote["source"]) => ({
  sourceId: source?.id ?? null,
  sourceKind: source?.kind ?? null,
});
