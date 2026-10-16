// Automation lane tRPC procedures. The lane adds its routers here and nowhere else.
import { inboxRouter } from "./inbox-router.ts";
import { router } from "./init.ts";
import { triggersRouter } from "./triggers-router.ts";

export const automationRouter = router({
  inbox: inboxRouter,
  triggers: triggersRouter,
});
