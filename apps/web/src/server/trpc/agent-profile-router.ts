import {
  askBeforeInputSchema,
  profileInputSchema,
  setAskBeforeInputSchema,
  setAskLevelInputSchema,
} from "@repo/services/agent-profile";
import { router, workspaceProcedure } from "./init.ts";

export const agentProfileRouter = router({
  askBefore: workspaceProcedure
    .input(askBeforeInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.agentProfile.askBefore(ctx.principal, input)
    ),
  askLevel: workspaceProcedure
    .input(profileInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.agentProfile.askLevel(ctx.principal, input)
    ),
  profile: workspaceProcedure
    .input(profileInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.agentProfile.profile(ctx.principal, input)
    ),
  setAskBefore: workspaceProcedure
    .input(setAskBeforeInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentProfile.setAskBefore(ctx.principal, input)
    ),
  setAskLevel: workspaceProcedure
    .input(setAskLevelInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.agentProfile.setAskLevel(ctx.principal, input)
    ),
});
