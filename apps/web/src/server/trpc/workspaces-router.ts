// Workspace procedures: the ones a person can switch to, and a new one.
import { INVITE_ROLES } from "@repo/services/workspaces";
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
});
