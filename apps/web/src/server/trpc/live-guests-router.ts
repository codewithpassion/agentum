import { z } from "zod";
import type { Context } from "./context";
import { router, workspaceProcedure } from "./init";

const service = async (ctx: Context) => {
  const guests = await ctx.services.liveGuests?.();
  if (!guests) {
    throw new Error("Guest access unavailable");
  }
  return guests;
};
const artifactId = z.uuid();
const role = z.enum(["viewer", "commenter", "editor"]);
export const liveGuestsRouter = router({
  changeRole: workspaceProcedure
    .input(
      z.strictObject({ artifactId, memberId: z.string().min(1).max(200), role })
    )
    .mutation(async ({ ctx, input }) =>
      (await service(ctx)).changeRole(ctx.principal, input)
    ),
  invite: workspaceProcedure
    .input(
      z.strictObject({
        agentRunsPerDay: z.number().int().min(0).max(1000).optional(),
        artifactId,
        email: z.email().max(320),
        expiresAt: z.iso.datetime().optional(),
        role,
      })
    )
    .mutation(async ({ ctx, input }) =>
      (await service(ctx)).invite(ctx.principal, input)
    ),
  revoke: workspaceProcedure
    .input(z.strictObject({ artifactId, memberId: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) =>
      (await service(ctx)).revoke(ctx.principal, input)
    ),
  setEnabled: workspaceProcedure
    .input(z.strictObject({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      (await service(ctx)).setEnabled(ctx.principal, input.enabled)
    ),
});
