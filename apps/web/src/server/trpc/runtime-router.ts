// Runtime lane tRPC procedures. The lane adds its routers here and nowhere else.
import { agentsRouter } from "./agents-router.ts";
import { router } from "./init.ts";
import { runsRouter } from "./runs-router.ts";

export const runtimeRouter = router({
  agents: agentsRouter,
  runs: runsRouter,
});
