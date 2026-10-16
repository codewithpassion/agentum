// Runtime lane tRPC procedures. The lane adds its routers here and nowhere else.
import { agentsRouter } from "./agents-router.ts";
import { eventsRouter } from "./events-router.ts";
import { filesRouter } from "./files-router.ts";
import { router } from "./init.ts";
import { libraryRouter } from "./library-router.ts";
import { machinesRouter } from "./machines-router.ts";
import { runsRouter } from "./runs-router.ts";
import { sessionsRouter } from "./sessions-router.ts";
import { skillsRouter } from "./skills-router.ts";
import { slackAppsRouter } from "./slack-apps-router.ts";

export const runtimeRouter = router({
  agents: agentsRouter,
  events: eventsRouter,
  files: filesRouter,
  library: libraryRouter,
  machines: machinesRouter,
  runs: runsRouter,
  sessions: sessionsRouter,
  skills: skillsRouter,
  slackApps: slackAppsRouter,
});
