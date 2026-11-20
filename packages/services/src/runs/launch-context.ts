import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { workspaces } from "@repo/db/schema/workspaces";
import { and, asc, eq } from "drizzle-orm";
import { type AgentRecord, handsToNames } from "../agents.ts";
import type { McpServerConnector } from "../connectors/mcp-servers.ts";
import { loadPrivateNotesUser } from "../library/private-notes.ts";
import {
  loadPromptMemory,
  type MemoryFileReader,
  type PromptMemory,
} from "../memory/prompt.ts";
import { slackGuidanceFor } from "../slack/guidance.ts";
import { effectiveRunScope, modelOfRun, scopeAllows } from "./access-scope.ts";
import { sessionSupportsSpeakers } from "./speakers.ts";
import type { RunAccessScope, RunRecord } from "./types.ts";

/**
 * What every runtime needs to start a run, read once: the cloud runner, the
 * machine claim and the managed session each map it to their own shape.
 */
export interface LaunchContext {
  /** The agent's connectors the run may reach, in a stable order. */
  connectors: McpServerConnector[];
  /** Names of the agents it can hand off to. */
  handoffNames: string[];
  /** Notes and rules for the prompt, null when the caller gave no way to read memory. */
  memory: PromptMemory | null;
  /** The model the run asks for. */
  model: string;
  /** The session has more than one speaker. */
  multiPerson: boolean;
  /** The run's effective access scope, null when unrestricted. */
  scope: RunAccessScope | null;
  /** The Slack paragraph for the agent's instructions, empty when none. */
  slack: string;
}

/** The run's notes and rules, read once. Private notes load by the rule in `library/private-notes.ts`. */
const memoryFor = async (
  db: Database,
  run: RunRecord,
  read: MemoryFileReader
): Promise<PromptMemory> => {
  const [agentRow] = await db
    .select({ remember: agents.remember })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.workspaceId, run.workspaceId))
    )
    .limit(1);
  const [workspaceRow] = await db
    .select({ never: workspaces.neverRemember })
    .from(workspaces)
    .where(eq(workspaces.id, run.workspaceId))
    .limit(1);
  return await loadPromptMemory(read, {
    agentRemember: agentRow?.remember ?? "",
    privateNotesUserId: await loadPrivateNotesUser(db, run),
    workspaceNever: workspaceRow?.never ?? "",
  });
};

export const buildLaunchContext = async (
  db: Database,
  run: RunRecord,
  agent: AgentRecord,
  options: { readMemoryFile?: MemoryFileReader } = {}
): Promise<LaunchContext> => {
  const assigned = await db
    .select({ id: connectors.id, name: connectors.name })
    .from(agentConnectors)
    .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
    .where(
      and(
        eq(agentConnectors.agentId, run.agentId),
        eq(agentConnectors.workspaceId, run.workspaceId)
      )
    )
    .orderBy(asc(agentConnectors.createdAt), asc(agentConnectors.connectorId));
  const scope = await effectiveRunScope(db, run.workspaceId, run.id);
  const multiPerson = await sessionSupportsSpeakers(db, run);
  return {
    connectors: assigned.filter((connector) =>
      scopeAllows(scope, "connectors", connector.id)
    ),
    handoffNames: await handsToNames(db, agent),
    memory: options.readMemoryFile
      ? await memoryFor(db, run, options.readMemoryFile)
      : null,
    model: modelOfRun(run, agent),
    multiPerson,
    scope,
    slack: await slackGuidanceFor(db, {
      agentId: run.agentId,
      workspaceId: run.workspaceId,
    }),
  };
};
