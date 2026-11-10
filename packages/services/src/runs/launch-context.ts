import type { Database } from "@repo/db";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { and, asc, eq } from "drizzle-orm";
import { type AgentRecord, handsToNames } from "../agents.ts";
import type { McpServerConnector } from "../connectors/mcp-servers.ts";
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
  /** The model the run asks for. */
  model: string;
  /** The session has more than one speaker. */
  multiPerson: boolean;
  /** The run's effective access scope, null when unrestricted. */
  scope: RunAccessScope | null;
  /** The Slack paragraph for the agent's instructions, empty when none. */
  slack: string;
}

export const buildLaunchContext = async (
  db: Database,
  run: RunRecord,
  agent: AgentRecord
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
  return {
    connectors: assigned.filter((connector) =>
      scopeAllows(scope, "connectors", connector.id)
    ),
    handoffNames: await handsToNames(db, agent),
    model: modelOfRun(run, agent),
    multiPerson: await sessionSupportsSpeakers(db, run),
    scope,
    slack: await slackGuidanceFor(db, {
      agentId: run.agentId,
      workspaceId: run.workspaceId,
    }),
  };
};
