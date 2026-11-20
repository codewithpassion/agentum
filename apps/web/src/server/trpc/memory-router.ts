import {
  addInputSchema,
  changesInputSchema,
  decideInputSchema,
  editInputSchema,
  forgetInputSchema,
  listInputSchema,
  rulesGetInputSchema,
  rulesSetInputSchema,
  undoInputSchema,
} from "@repo/services/memory";
import { router, workspaceProcedure } from "./init.ts";

export const memoryRouter = router({
  add: workspaceProcedure
    .input(addInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.memory.add(ctx.principal, input)
    ),
  changes: workspaceProcedure
    .input(changesInputSchema)
    .query(({ ctx, input }) =>
      ctx.services.memory.changes(ctx.principal, input)
    ),
  decide: workspaceProcedure
    .input(decideInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.memory.decide(ctx.principal, input)
    ),
  edit: workspaceProcedure
    .input(editInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.memory.edit(ctx.principal, input)
    ),
  forget: workspaceProcedure
    .input(forgetInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.memory.forget(ctx.principal, input)
    ),
  list: workspaceProcedure
    .input(listInputSchema)
    .query(({ ctx, input }) => ctx.services.memory.list(ctx.principal, input)),
  rules: router({
    get: workspaceProcedure
      .input(rulesGetInputSchema)
      .query(({ ctx, input }) =>
        ctx.services.memory.rules.get(ctx.principal, input)
      ),
    set: workspaceProcedure
      .input(rulesSetInputSchema)
      .mutation(({ ctx, input }) =>
        ctx.services.memory.rules.set(ctx.principal, input)
      ),
  }),
  undo: workspaceProcedure
    .input(undoInputSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.memory.undo(ctx.principal, input.changeId)
    ),
});
