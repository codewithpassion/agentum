// Workspace procedures: the ones a person can switch to, and a new one.
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
  /** The workspaces the signed-in person belongs to, with their role in each. */
  mine: signedInProcedure.query(({ ctx }) =>
    ctx.services.workspaces.mine(ctx.userId)
  ),
});
