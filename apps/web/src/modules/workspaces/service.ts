import { and, asc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { deleteActivityForAgents } from "#/modules/activity/service";
import { deleteAgentsForWorkspace } from "#/modules/agents/service";
import { deleteBridgesForWorkspace } from "#/modules/bridges/bridges";
import { deleteSlackAppsForWorkspace } from "#/modules/bridges/slack/apps";
import { deleteBrowserDataForAgents } from "#/modules/browser/service";
import { deleteCategoriesForWorkspace } from "#/modules/categories/service";
import { deleteConnectorsForWorkspace } from "#/modules/connectors/service";
import { deleteChannelsForWorkspace } from "#/modules/messaging/service";
import { deleteQuestionsForWorkspace } from "#/modules/questions/service";
import { deleteRoutinesForWorkspace } from "#/modules/routines/service";
import { deleteSkillsForWorkspace } from "#/modules/skills/service";
import { deletePagesForWorkspace } from "#/modules/wiki/service";
import {
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
  workspaceMembers,
  workspaces,
} from "./schema";

/**
 * The workspace every row created before multi-tenancy belongs to. The literal
 * matches the row migration 0012 inserts, which is what lets a route name a
 * workspace before `requireWorkspace` exists to resolve one from the URL.
 *
 * No route names it any more - they all read `c.get("workspace")`. It survives
 * for the scripts and tests that need the same literal migration 0012 inserted.
 */
export const DEFAULT_WORKSPACE_ID = "ws_default";

const SLUG_MAX_LENGTH = 48;
const SLUG_FALLBACK = "workspace";
const SLUG_SUFFIX_LENGTH = 6;
const SLUG_ATTEMPTS = 3;

const NON_SLUG_CHARACTERS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * Names are free text; slugs are the public identifier and are immutable, so
 * this runs once, at creation. An all-punctuation name still needs a slug,
 * hence the fallback.
 */
export const slugFromName = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(NON_SLUG_CHARACTERS, "-")
    .replace(EDGE_DASHES, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(EDGE_DASHES, "");
  return slug || SLUG_FALLBACK;
};

const withSuffix = (slug: string): string => {
  const suffix = crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, SLUG_SUFFIX_LENGTH);
  return `${slug.slice(0, SLUG_MAX_LENGTH - SLUG_SUFFIX_LENGTH - 1)}-${suffix}`;
};

/** What a workspace looks like from outside: the slug is the identifier. */
export interface WorkspaceView {
  createdAt: Date;
  name: string;
  slug: string;
}

export const toWorkspaceView = (workspace: Workspace): WorkspaceView => ({
  createdAt: workspace.createdAt,
  name: workspace.name,
  slug: workspace.slug,
});

/**
 * A member without the Clerk id. Everything that serializes a member goes
 * through here, which is what makes the "never show the Clerk user id" rule a
 * property of the code rather than a habit.
 */
export interface MemberView {
  email: string;
  id: string;
  imageUrl: string | null;
  name: string | null;
  role: WorkspaceRole;
}

export const toMemberView = (member: WorkspaceMember): MemberView => ({
  email: member.email,
  id: member.id,
  imageUrl: member.imageUrl,
  name: member.name,
  role: member.role,
});

export interface WorkspaceOwnerSnapshot {
  clerkUserId: string;
  email: string;
  imageUrl: string | null;
  name: string | null;
}

/**
 * The creator becomes the first owner in the same call: a workspace with no
 * owner is unreachable - `requireWorkspace` would 404 it for everybody.
 *
 * The slug is derived from the name and retried with a random suffix when it
 * is taken, since slugs are globally unique and names are not.
 */
export const createWorkspace = async (
  db: Db,
  input: { name: string; owner: WorkspaceOwnerSnapshot }
): Promise<{ member: WorkspaceMember; workspace: Workspace }> => {
  const base = slugFromName(input.name);
  let workspace: Workspace | undefined;

  for (let attempt = 0; attempt < SLUG_ATTEMPTS && !workspace; attempt += 1) {
    const slug = attempt === 0 ? base : withSuffix(base);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: the retry only happens on a slug collision, and it needs the previous attempt's answer.
      [workspace] = await db
        .insert(workspaces)
        .values({ id: crypto.randomUUID(), name: input.name, slug })
        .returning();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }

  if (!workspace) {
    throw new Error(`Could not derive a free slug from "${input.name}".`);
  }

  const member = await addMember(db, workspace.id, {
    ...input.owner,
    role: "owner",
  });
  return { member, workspace };
};

/** Every workspace the user belongs to, with the membership that got them in. */
export const listWorkspacesForUser = async (
  db: Db,
  clerkUserId: string
): Promise<{ member: WorkspaceMember; workspace: Workspace }[]> => {
  const rows = await db
    .select({ member: workspaceMembers, workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.clerkUserId, clerkUserId))
    .orderBy(asc(workspaces.name));
  return rows;
};

export const getWorkspaceBySlug = async (
  db: Db,
  slug: string
): Promise<Workspace | undefined> => {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug));
  return workspace;
};

/**
 * For the paths that know a workspace id but not its slug - the agents' MCP
 * endpoint and the Slack bridge, both of which arrive with a row rather than a
 * URL and still have to address the workspace's own URLs.
 */
export const getWorkspaceById = async (
  db: Db,
  id: string
): Promise<Workspace | undefined> => {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  return workspace;
};

/** The membership check behind `requireWorkspace`; undefined means "not a member". */
export const findMembership = async (
  db: Db,
  workspaceId: string,
  clerkUserId: string
): Promise<WorkspaceMember | undefined> => {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.clerkUserId, clerkUserId)
      )
    );
  return member;
};

/** Renames the workspace only: the slug it was created with is immutable. */
export const renameWorkspace = async (
  db: Db,
  workspaceId: string,
  name: string
): Promise<Workspace | undefined> => {
  const [workspace] = await db
    .update(workspaces)
    .set({ name, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  return workspace;
};

/**
 * Deletes the workspace and everything under it.
 *
 * `workspace_id` is plain text on every root table - no foreign key, by design,
 * so no module depends on another's schema - which means nothing cascades from
 * the `workspaces` row except the memberships. Left alone, a deleted
 * workspace's rows would survive unreachable, and its agents would keep a live
 * `/mcp/:token` surface: the credential lookup is global, so an orphaned agent
 * is still a usable one. Hence: roots first, through each module's own service,
 * and only then the workspace itself.
 *
 * What follows by `ON DELETE CASCADE` from those roots: channel members,
 * messages, message mentions and attachments (from `channels`), wiki revisions
 * and assets (from `wiki_pages`), category items (from `categories`). What does
 * not, and is deleted by hand: agent activity, browser sessions and
 * screenshots, connector assignments and OAuth flows, skill versions and files,
 * routine runs, agent questions.
 *
 * R2 objects (attachments, wiki assets, skill files, screenshots) are left
 * behind - unreachable, and worth less than making this a bucket-wide sweep.
 */
export const deleteWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<boolean> => {
  const agentIds = await deleteAgentsForWorkspace(db, workspaceId);
  await deleteActivityForAgents(db, agentIds);
  await deleteBrowserDataForAgents(db, agentIds);

  await deleteBridgesForWorkspace(db, workspaceId);
  await deleteSlackAppsForWorkspace(db, workspaceId);
  await deleteChannelsForWorkspace(db, workspaceId);
  await deleteCategoriesForWorkspace(db, workspaceId);
  await deleteConnectorsForWorkspace(db, workspaceId);
  await deleteSkillsForWorkspace(db, workspaceId);
  await deleteRoutinesForWorkspace(db, workspaceId);
  await deleteQuestionsForWorkspace(db, workspaceId);
  await deletePagesForWorkspace(db, workspaceId);

  const deleted = await db
    .delete(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id });
  return deleted.length > 0;
};

export const listMembers = (
  db: Db,
  workspaceId: string
): Promise<WorkspaceMember[]> =>
  db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.email));

export const getMemberById = async (
  db: Db,
  workspaceId: string,
  memberId: string
): Promise<WorkspaceMember | undefined> => {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.id, memberId)
      )
    );
  return member;
};

export interface AddMemberInput extends WorkspaceOwnerSnapshot {
  role: WorkspaceRole;
}

/**
 * Throws a unique-constraint error when the Clerk user is already a member -
 * the caller turns that into a 409, which is also the check against a
 * double-submitted invite.
 */
export const addMember = async (
  db: Db,
  workspaceId: string,
  input: AddMemberInput
): Promise<WorkspaceMember> => {
  const [member] = await db
    .insert(workspaceMembers)
    .values({
      clerkUserId: input.clerkUserId,
      email: input.email,
      id: crypto.randomUUID(),
      imageUrl: input.imageUrl,
      name: input.name,
      role: input.role,
      workspaceId,
    })
    .returning();
  if (!member) {
    throw new Error("Failed to add the member.");
  }
  return member;
};

export const setMemberRole = async (
  db: Db,
  workspaceId: string,
  memberId: string,
  role: WorkspaceRole
): Promise<WorkspaceMember | undefined> => {
  const [member] = await db
    .update(workspaceMembers)
    .set({ role })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.id, memberId)
      )
    )
    .returning();
  return member;
};

export const removeMember = async (
  db: Db,
  workspaceId: string,
  memberId: string
): Promise<boolean> => {
  const deleted = await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.id, memberId)
      )
    )
    .returning({ id: workspaceMembers.id });
  return deleted.length > 0;
};

/** The last-owner guard: a workspace nobody owns can never be managed again. */
export const countOwners = async (
  db: Db,
  workspaceId: string
): Promise<number> => {
  const owners = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "owner")
      )
    );
  return owners.length;
};

/**
 * Refreshes the display snapshot from Clerk. Used for the memberships
 * migration 0012 created with an empty email, which is the only way a member
 * has no email at all.
 */
export const refreshMemberSnapshot = async (
  db: Db,
  memberId: string,
  snapshot: { email: string; imageUrl: string | null; name: string | null }
): Promise<void> => {
  await db
    .update(workspaceMembers)
    .set(snapshot)
    .where(eq(workspaceMembers.id, memberId));
};
