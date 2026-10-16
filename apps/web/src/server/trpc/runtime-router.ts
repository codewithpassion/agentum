// Runtime lane tRPC procedures. The lane adds its routers here and nowhere else.
import { agentsRouter } from "./agents-router.ts";
import { router } from "./init.ts";
import { machinesRouter } from "./machines-router.ts";
import { runsRouter } from "./runs-router.ts";
import { sessionsRouter } from "./sessions-router.ts";

export const runtimeRouter = router({
  agents: agentsRouter,
  machines: machinesRouter,
  runs: runsRouter,
  sessions: sessionsRouter,
});
