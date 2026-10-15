import { createNoteInput } from "@repo/services/notes";
import { publicProcedure, router } from "../init.ts";

// Thin on purpose: input validation and business rules live in
// @repo/services, so the router only maps calls onto the service.
export const notesRouter = router({
  create: publicProcedure
    .input(createNoteInput)
    .mutation(({ ctx, input }) => ctx.services.notes.create(input)),
  list: publicProcedure.query(({ ctx }) => ctx.services.notes.list()),
});
