import {
  profileGetInputSchema,
  profileSetInputSchema,
  setLeadInputSchema,
  setRulesInputSchema,
  slackLinkInputSchema,
  teamCreateInputSchema,
  teamIdInputSchema,
  teamMemberInputSchema,
  teamMemberRefInputSchema,
  teamUpdateInputSchema,
} from "@repo/services/teams";
import { router, workspaceProcedure } from "./init.ts";

export const teamsRouter = router({
  addMember: workspaceProcedure
    .input(teamMemberInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.addMember(ctx.principal, input)
    ),
  archive: workspaceProcedure
    .input(teamIdInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.archive(ctx.principal, input.teamId)
    ),
  create: workspaceProcedure
    .input(teamCreateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.create(ctx.principal, input)
    ),
  get: workspaceProcedure
    .input(teamIdInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.teams.get(ctx.principal, input.teamId)
    ),
  list: workspaceProcedure.query(({ ctx }) =>
    ctx.services.teams.list(ctx.principal)
  ),
  profiles: router({
    get: workspaceProcedure
      .input(profileGetInputSchema)
      .query(({ ctx, input }) =>
        ctx.services.teams.profiles.get(ctx.principal, input)
      ),
    set: workspaceProcedure
      .input(profileSetInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.services.teams.profiles.set(ctx.principal, input)
      ),
  }),
  removeMember: workspaceProcedure
    .input(teamMemberRefInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.removeMember(ctx.principal, input)
    ),
  setLead: workspaceProcedure
    .input(setLeadInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.setLead(ctx.principal, input)
    ),
  setRules: workspaceProcedure
    .input(setRulesInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.setRules(ctx.principal, input)
    ),
  slack: router({
    channels: workspaceProcedure
      .input(teamIdInputSchema)
      .query(({ ctx, input }) =>
        ctx.services.teams.slack.channels(ctx.principal, input.teamId)
      ),
    link: workspaceProcedure
      .input(slackLinkInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.services.teams.slack.link(ctx.principal, input)
      ),
    status: workspaceProcedure
      .input(teamIdInputSchema)
      .query(({ ctx, input }) =>
        ctx.services.teams.slack.status(ctx.principal, input.teamId)
      ),
    unlink: workspaceProcedure
      .input(teamIdInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.services.teams.slack.unlink(ctx.principal, input.teamId)
      ),
  }),
  update: workspaceProcedure
    .input(teamUpdateInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.teams.update(ctx.principal, input)
    ),
});
