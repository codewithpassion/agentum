import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import { machines } from "@repo/db/schema/machines";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { effectiveAskKeys } from "@repo/protocol/requests";
import { and, asc, eq } from "drizzle-orm";
import {
  ASK_BY_DEFAULT,
  gateableActions,
  levelAsks,
} from "../agent-profile/ask-before.ts";
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
 * The actions that ask whatever the level says, because the agent's computer
 * allows apps and so the agent can act inside them. Empty for any other agent.
 */
export const desktopAsksByDefault = async (
  db: Database,
  agent: { id: string; workspaceId: string }
): Promise<ReadonlySet<string>> => {
  const [row] = await db
    .select({ capabilities: machines.computerCapabilities })
    .from(agents)
    .innerJoin(
      machines,
      and(
        eq(machines.id, agents.computerMachineId),
        eq(machines.workspaceId, agents.workspaceId)
      )
    )
    .where(
      and(eq(agents.id, agent.id), eq(agents.workspaceId, agent.workspaceId))
    )
    .limit(1);
  try {
    const parsed: unknown = JSON.parse(row?.capabilities ?? "null");
    const on =
      typeof parsed === "object" &&
      parsed !== null &&
      "agentDesktop" in parsed &&
      parsed.agentDesktop === true;
    return on ? ASK_BY_DEFAULT : new Set();
  } catch {
    return new Set();
  }
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
  const [[row], rules, always] = await Promise.all([
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
    desktopAsksByDefault(db, agent),
  ]);
  const level = row?.level ?? "custom";
  const ruled = new Set(rules.map(({ toolKey }) => toolKey));
  // A custom agent's rules decide, so only the built-ins that always ask are added to them.
  const fromLevel = gateableActions(
    level === "custom" ? [] : await assignedConnectors(db, agent)
  )
    .filter(
      (action) =>
        (always.has(action.key) || levelAsks(level, action)) &&
        !ruled.has(action.key)
    )
    .map(({ key }) => ({ mode: "ask", toolKey: key }));
  return effectiveAskKeys([...rules, ...fromLevel]);
};
