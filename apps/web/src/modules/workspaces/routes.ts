import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  readJsonObject,
  requireEnum,
  requireString,
} from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { isUniqueConstraintError } from "#/db/errors";
import { type ClerkDirectory, clerkDirectoryFromEnv } from "./clerk-directory";
import { requireOwner, requireWorkspace } from "./require-workspace";
import {
  WORKSPACE_ROLES,
  type Workspace,
  type WorkspaceMember,
} from "./schema";
import {
  addMember,
  countOwners,
  createWorkspace,
  deleteWorkspace,
  getMemberById,
  listMembers,
  listWorkspacesForUser,
  refreshMemberSnapshot,
  removeMember,
  renameWorkspace,
  setMemberRole,
  toMemberView,
  toWorkspaceView,
} from "./service";

const NAME_MAX_LENGTH = 80;
const EMAIL_MAX_LENGTH = 320;

/**
 * The workspace plus the caller's own membership. The member id is the only
 * identity the client ever gets for itself - `isSelf` compares against it,
 * never against a Clerk id.
 */
const workspaceResponse = (workspace: Workspace, member: WorkspaceMember) => ({
  membership: { memberId: member.id, role: member.role },
  workspace: toWorkspaceView(workspace),
});

/** `/api/workspaces` - the only workspace routes that name no workspace. */
export const workspacesRoutes = new Hono<ApiEnv>();

workspacesRoutes.use("*", requireAuth);

workspacesRoutes.get("/", async (c) => {
  const mine = await listWorkspacesForUser(createDb(c.env.DB), c.get("userId"));
  return c.json({
    workspaces: mine.map((row) => workspaceResponse(row.workspace, row.member)),
  });
});

workspacesRoutes.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = requireString(body, "name", { maxLength: NAME_MAX_LENGTH });

  const clerkUserId = c.get("userId");
  const profile = await clerkDirectoryFromEnv(c.env).getUser(clerkUserId);
  if (!profile) {
    // Better to refuse than to seat an owner whose email we cannot show: an
    // unidentifiable owner is exactly what the member list cannot render.
    return c.json(
      { error: "Could not read your profile. Please try again." },
      502
    );
  }

  const { member, workspace } = await createWorkspace(createDb(c.env.DB), {
    name,
    owner: profile,
  });
  return c.json(workspaceResponse(workspace, member), 201);
});

/**
 * Everything that happens *inside* a workspace, mounted at
 * `/api/w/:workspaceSlug` - the parameter is named for the workspace because
 * the wiki and skills routers address their own rows by `:slug`, and Hono
 * merges a nested router's parameters with its mount's.
 * The two gates are part of this router rather than of the mount, so no caller
 * can mount it without them: `requireWorkspace` answers the same 404 for an
 * unknown slug and for a workspace the caller does not belong to, and leaves
 * the workspace and the caller's membership on the context.
 *
 * The resource routers hang off this same instance, from `server.ts`
 * (`workspaceScopedRoutes.route("/agents", agentsRoutes)`, …), which is what
 * gives every one of them the scope for free.
 */
export const workspaceScopedRoutes = new Hono<ApiEnv>();

workspaceScopedRoutes.use("*", requireAuth, requireWorkspace);

workspaceScopedRoutes.get("/", (c) =>
  c.json(workspaceResponse(c.get("workspace"), c.get("member")))
);

workspaceScopedRoutes.patch("/", requireOwner, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = requireString(body, "name", { maxLength: NAME_MAX_LENGTH });

  // The slug stays as it was created: it is the workspace's public identifier.
  const workspace = await renameWorkspace(
    createDb(c.env.DB),
    c.get("workspace").id,
    name
  );
  if (!workspace) {
    throw notFound("Workspace not found.");
  }
  return c.json(workspaceResponse(workspace, c.get("member")));
});

workspaceScopedRoutes.delete("/", requireOwner, async (c) => {
  await deleteWorkspace(createDb(c.env.DB), c.get("workspace").id);
  return c.body(null, 204);
});

/**
 * Fills in the snapshots migration 0012 could not: memberships it created from
 * existing data carry an empty email until somebody asks Clerk. Best-effort -
 * a Clerk outage must not take the member list down with it.
 */
const withRefreshedSnapshots = async (
  db: Db,
  directory: ClerkDirectory,
  members: WorkspaceMember[]
): Promise<WorkspaceMember[]> => {
  const pending = members.filter((member) => member.email === "");
  if (pending.length === 0) {
    return members;
  }

  const refreshed = new Map<string, WorkspaceMember>();
  try {
    await Promise.all(
      pending.map(async (member) => {
        const profile = await directory.getUser(member.clerkUserId);
        if (!profile) {
          return;
        }
        const snapshot = {
          email: profile.email,
          imageUrl: profile.imageUrl,
          name: profile.name,
        };
        await refreshMemberSnapshot(db, member.id, snapshot);
        refreshed.set(member.id, { ...member, ...snapshot });
      })
    );
  } catch {
    // Whatever did land is still returned; the next fetch retries the rest.
  }

  return members.map((member) => refreshed.get(member.id) ?? member);
};

workspaceScopedRoutes.get("/members", async (c) => {
  const db = createDb(c.env.DB);
  const members = await listMembers(db, c.get("workspace").id);
  const current = await withRefreshedSnapshots(
    db,
    clerkDirectoryFromEnv(c.env),
    members
  );
  return c.json({ members: current.map(toMemberView) });
});

/** Existing Clerk users only - there are no pending invites (see the plan). */
workspaceScopedRoutes.post("/members", requireOwner, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const email = requireString(body, "email", {
    maxLength: EMAIL_MAX_LENGTH,
  }).toLowerCase();
  const role =
    body.role === undefined
      ? ("member" as const)
      : requireEnum(body, "role", WORKSPACE_ROLES);

  const profile = await clerkDirectoryFromEnv(c.env).findUserByEmail(email);
  if (!profile) {
    throw notFound(
      `No account for ${email}. They have to sign up before they can be added.`
    );
  }

  try {
    const member = await addMember(createDb(c.env.DB), c.get("workspace").id, {
      ...profile,
      role,
    });
    return c.json({ member: toMemberView(member) }, 201);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: `${email} is already a member.` }, 409);
    }
    throw error;
  }
});

/** Who an email belongs to, before adding them. The Clerk id stays here. */
workspaceScopedRoutes.get("/members/search", requireOwner, async (c) => {
  const email = c.req.query("email")?.trim().toLowerCase();
  if (!email) {
    throw badRequest('"email" is required.');
  }

  const profile = await clerkDirectoryFromEnv(c.env).findUserByEmail(email);
  return c.json({
    email: profile ? profile.email : email,
    exists: profile !== undefined,
    imageUrl: profile?.imageUrl ?? null,
    name: profile?.name ?? null,
  });
});

workspaceScopedRoutes.patch("/members/:memberId", requireOwner, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const role = requireEnum(body, "role", WORKSPACE_ROLES);

  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const memberId = c.req.param("memberId");

  const member = await getMemberById(db, workspaceId, memberId);
  if (!member) {
    throw notFound("Member not found.");
  }
  if (member.role === "owner" && role !== "owner") {
    const owners = await countOwners(db, workspaceId);
    if (owners <= 1) {
      return c.json(
        { error: "A workspace has to keep at least one owner." },
        409
      );
    }
  }

  const updated = await setMemberRole(db, workspaceId, memberId, role);
  if (!updated) {
    throw notFound("Member not found.");
  }
  return c.json({ member: toMemberView(updated) });
});

workspaceScopedRoutes.delete("/members/:memberId", requireOwner, async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const memberId = c.req.param("memberId");

  const member = await getMemberById(db, workspaceId, memberId);
  if (!member) {
    throw notFound("Member not found.");
  }
  if (member.role === "owner" && (await countOwners(db, workspaceId)) <= 1) {
    return c.json(
      { error: "A workspace has to keep at least one owner." },
      409
    );
  }

  await removeMember(db, workspaceId, memberId);
  return c.body(null, 204);
});
