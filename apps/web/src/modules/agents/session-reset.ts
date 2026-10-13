import type { Db } from "#/db/client";
import {
  backfillSessionHistory,
  syncAgentWithAnthropic,
} from "#/modules/anthropic/service";
import type { WorkspaceRef } from "#/modules/messaging/service";
import {
  findAgentDmId,
  postSessionDivider,
} from "#/modules/messaging/session-divider";
import { retireAgentSession } from "#/modules/router/retire";
import type { Agent } from "./schema";

/**
 * Starts a new session for an agent: brings its registration up to date, keeps
 * the session in the history, drops it so the next message starts a fresh one,
 * and marks the change with a divider in the conversation where it happened.
 * The session reset route, `/clear`, and the tools-changed path all end here.
 */
export const resetAgentSession = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  agent: Agent,
  options: { channelId?: string } = {}
): Promise<{ retired: boolean }> => {
  await syncAgentWithAnthropic(db, env, agent.id);
  // Before the retire: the current session needs a history row to be closed.
  await backfillSessionHistory(db, env, agent);
  const { retired } = await retireAgentSession(env, workspace.id, agent.id);

  // The owner's button has no conversation of its own: it marks the DM.
  const channelId =
    options.channelId ?? (await findAgentDmId(db, workspace.id, agent.id));
  if (channelId) {
    await postSessionDivider(db, env, {
      agent,
      channelId,
      workspaceId: workspace.id,
    });
  }
  return { retired };
};
