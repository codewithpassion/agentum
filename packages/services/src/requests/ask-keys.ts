import type { Database } from "@repo/db";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { effectiveAskKeys } from "@repo/protocol/requests";
import { and, eq } from "drizzle-orm";

/**
 * The tool keys a run of the agent asks a person about, sorted: its `ask` rules
 * and the platform tools their switches cover (`SWITCH_COVERS`). Every runtime
 * gates from this, so a switch means the same on cloud, VM, managed and machine.
 */
export const askKeysOf = async (
  db: Database,
  agent: { id: string; workspaceId: string }
): Promise<string[]> =>
  effectiveAskKeys(
    await db
      .select({ mode: agentToolRules.mode, toolKey: agentToolRules.toolKey })
      .from(agentToolRules)
      .where(
        and(
          eq(agentToolRules.agentId, agent.id),
          eq(agentToolRules.workspaceId, agent.workspaceId)
        )
      )
  );
