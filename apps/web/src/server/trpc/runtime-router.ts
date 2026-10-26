// Runtime lane tRPC procedures. The lane adds its routers here and nowhere else.
import { agentProfileRouter } from "./agent-profile-router.ts";
import { agentsRouter } from "./agents-router.ts";
import { deskRouter } from "./desk-router.ts";
import { eventsRouter } from "./events-router.ts";
import { filesRouter } from "./files-router.ts";
import { router } from "./init.ts";
import { libraryRouter } from "./library-router.ts";
import { machinesRouter } from "./machines-router.ts";
import { managedKeysRouter } from "./managed-keys-router.ts";
import { modelKeysRouter } from "./model-keys-router.ts";
import { requestsRouter } from "./requests-router.ts";
import { runsRouter } from "./runs-router.ts";
import { secretsRouter } from "./secrets-router.ts";
import { sessionsRouter } from "./sessions-router.ts";
import { skillStoreRouter } from "./skill-store-router.ts";
import { skillsRouter } from "./skills-router.ts";
import { slackAppsRouter } from "./slack-apps-router.ts";
import { tasksRouter } from "./tasks-router.ts";

export const runtimeRouter = router({
  agentProfile: agentProfileRouter,
  agents: agentsRouter,
  desk: deskRouter,
  events: eventsRouter,
  files: filesRouter,
  library: libraryRouter,
  machines: machinesRouter,
  managedKeys: managedKeysRouter,
  modelKeys: modelKeysRouter,
  requests: requestsRouter,
  runs: runsRouter,
  secrets: secretsRouter,
  sessions: sessionsRouter,
  skillStore: skillStoreRouter,
  skills: skillsRouter,
  slackApps: slackAppsRouter,
  tasks: tasksRouter,
});
