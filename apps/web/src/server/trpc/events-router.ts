import { eventLogFiltersSchema } from "@repo/services/events";
import { router, workspaceProcedure } from "./init.ts";

export const eventsRouter = router({
  list: workspaceProcedure
    .input(eventLogFiltersSchema)
    .query(({ ctx, input }) => ctx.services.events.list(ctx.principal, input)),
});
