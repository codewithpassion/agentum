// Workspace procedures: the ones a person can switch to, and a new one.
import { INVITE_ROLES } from "@repo/services/workspaces";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, signedInProcedure, workspaceProcedure } from "./init.ts";

export const workspacesRouter = router({
  /** Makes a workspace and its Clerk organisation. The caller must be an admin of the current one. */
  create: workspaceProcedure
    .input(z.strictObject({ name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const workspace = await ctx.services.workspaces.createFromSession(
        ctx.principal,
        input
      );
      return { clerkOrgId: workspace.clerkOrgId };
    }),
  /** Whether an organisation has a workspace row. Reveals nothing else about it. */
  hasWorkspace: signedInProcedure
    .input(z.strictObject({ org: z.string().min(1) }))
    .query(async ({ ctx, input }) => ({
      exists: await ctx.services.workspaces.hasWorkspace(input.org),
    })),
  /** Emails an invitation to the current workspace. The caller must be an admin of it. */
  invite: workspaceProcedure
    .input(z.strictObject({ email: z.string(), role: z.enum(INVITE_ROLES) }))
    .mutation(({ ctx, input }) =>
      ctx.services.workspaces.inviteFromSession(ctx.principal, input)
    ),
  /** The workspaces the signed-in person belongs to, with their role in each. */
  mine: signedInProcedure.query(({ ctx }) =>
    ctx.services.workspaces.mine(ctx.userId)
  ),
  /** Sets the timezone the workspace's routines read their schedules in. The caller must be an admin. */
  setTimezone: workspaceProcedure
    .input(z.strictObject({ timezone: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.services.workspaces.setTimezone(ctx.principal, input.timezone)
    ),
  /** The timezone the workspace's routines read their schedules in. Any member may read it. */
  timezone: workspaceProcedure.query(async ({ ctx }) => {
    const workspace = await ctx.services.workspaces.byId(
      ctx.principal.workspaceId
    );
    if (!workspace) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found.",
      });
    }
    return { timezone: workspace.timezone };
  }),
});
