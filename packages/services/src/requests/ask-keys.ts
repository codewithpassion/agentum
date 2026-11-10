import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { effectiveAskKeys } from "@repo/protocol/requests";
import { and, asc, eq } from "drizzle-orm";
import { gateableActions, levelAsks } from "../agent-profile/ask-before.ts";
import { decodeAllowedTools } from "../connectors/allowed-tools.ts";
import { toolSchema } from "../connectors/tool-schema.ts";

const assignedConnectors = async (
  db: Database,
  agent: { id: string; workspaceId: string }
) => {
  const rows = await db
    .select({
      allowedTools: agentConnectors.allowedTools,
      name: connectors.name,
      tools: connectors.tools,
    })
    .from(agentConnectors)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, agentConnectors.connectorId),
        eq(connectors.workspaceId, agentConnectors.workspaceId)
      )
    )
    .where(
      and(
        eq(agentConnectors.workspaceId, agent.workspaceId),
        eq(agentConnectors.agentId, agent.id)
      )
    )
    .orderBy(asc(agentConnectors.createdAt), asc(agentConnectors.connectorId));
  return rows.map((row) => ({
    allowedTools: decodeAllowedTools(row.allowedTools),
    name: row.name,
    tools: toolSchema.parse(JSON.parse(row.tools)),
  }));
};

/**
 * The tool keys a run of the agent asks a person about, sorted: the actions its
 * ask level covers, the `ask` rules, and the platform tools their switches cover
 * (`SWITCH_COVERS`). A rule on an action is an override of the level, either way.
 * Every runtime gates from this, so a switch means the same on cloud, VM,
 * managed and machine.
 */
export const askKeysOf = async (
  db: Database,
  agent: { id: string; workspaceId: string }
): Promise<string[]> => {
  const where = and(
    eq(agentToolRules.agentId, agent.id),
    eq(agentToolRules.workspaceId, agent.workspaceId)
  );
  const [[row], rules] = await Promise.all([
    db
      .select({ level: agents.askLevel })
      .from(agents)
      .where(
        and(eq(agents.id, agent.id), eq(agents.workspaceId, agent.workspaceId))
      )
      .limit(1),
    db
      .select({ mode: agentToolRules.mode, toolKey: agentToolRules.toolKey })
      .from(agentToolRules)
      .where(where),
  ]);
  const level = row?.level ?? "custom";
  if (level === "custom") {
    return effectiveAskKeys(rules);
  }
  const ruled = new Set(rules.map(({ toolKey }) => toolKey));
  const fromLevel = gateableActions(await assignedConnectors(db, agent))
    .filter((action) => levelAsks(level, action) && !ruled.has(action.key))
    .map(({ key }) => ({ mode: "ask", toolKey: key }));
  return effectiveAskKeys([...rules, ...fromLevel]);
};
