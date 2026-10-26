// Runtime lane tRPC procedures. The lane adds its routers here and nowhere else.
import { agentBuilderRouter } from "./agent-builder-router.ts";
import { agentProfileRouter } from "./agent-profile-router.ts";
import { agentsRouter } from "./agents-router.ts";
import { deskRouter } from "./desk-router.ts";
import { eventsRouter } from "./events-router.ts";
import { filesRouter } from "./files-router.ts";
import { router } from "./init.ts";
import { libraryRouter } from "./library-router.ts";
import { machinesRouter } from "./machines-router.ts";
import { managedKeysRouter } from "./managed-keys-router.ts";
import { mapRouter } from "./map-router.ts";
import { modelKeysRouter } from "./model-keys-router.ts";
import { qaRouter } from "./qa-router.ts";
import { requestsRouter } from "./requests-router.ts";
import { runsRouter } from "./runs-router.ts";
import { secretsRouter } from "./secrets-router.ts";
import { sessionsRouter } from "./sessions-router.ts";
import { skillStoreRouter } from "./skill-store-router.ts";
import { skillsRouter } from "./skills-router.ts";
import { slackAppsRouter } from "./slack-apps-router.ts";
import { takeoverRouter } from "./takeover-router.ts";
import { tasksRouter } from "./tasks-router.ts";
import { wikiRouter } from "./wiki-router.ts";

export const runtimeRouter = router({
  agentBuilder: agentBuilderRouter,
  agentProfile: agentProfileRouter,
  agents: agentsRouter,
  desk: deskRouter,
  events: eventsRouter,
  files: filesRouter,
  library: libraryRouter,
  machines: machinesRouter,
  managedKeys: managedKeysRouter,
  map: mapRouter,
  modelKeys: modelKeysRouter,
  qa: qaRouter,
  requests: requestsRouter,
  runs: runsRouter,
  secrets: secretsRouter,
  sessions: sessionsRouter,
  skillStore: skillStoreRouter,
  skills: skillsRouter,
  slackApps: slackAppsRouter,
  takeover: takeoverRouter,
  tasks: tasksRouter,
  wiki: wikiRouter,
});
