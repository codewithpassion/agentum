import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import {
  listAgents,
  setAgentRegistration,
  setAgentSyncStatus,
} from "#/modules/agents/service";
import { ENVIRONMENT_NAME } from "./config";
import {
  type AnthropicGateway,
  createAnthropicGateway,
  type EnvironmentCache,
} from "./gateway";
import { appConfig, ENVIRONMENT_ID_KEY } from "./schema";
import { composeSystemPrompt, rosterFor } from "./system-prompt";

/**
 * The Worker-facing half of the Anthropic integration: it owns the client, the
 * environment-id cache, and keeping every agent's registration in step with the
 * workspace. Registration is best-effort by design - the UI must work with no
 * key configured and with the API down.
 */

const DISABLED = "1";
const E2E_MODE = "e2e";

/**
 * The key alone is not enough to enable the integration: the end-to-end suite
 * drives a dev server that loads the same `.env.local`, and it must never
 * create real agents or sessions.
 *
 * The mode check is what makes that possible. A Worker variable cannot do it:
 * `.env.local` outranks both the process environment and `CLOUDFLARE_ENV`
 * (verified 2026-08-20), so there is no way to unset the key for one run. Vite's
 * mode does reach the Worker bundle, and `playwright.config.ts` starts the
 * server with `--mode e2e`.
 */
export const isAnthropicEnabled = (env: Env): boolean =>
  Boolean(env.ANTHROPIC_API_KEY) &&
  env.ANTHROPIC_DISABLED !== DISABLED &&
  import.meta.env.MODE !== E2E_MODE;

const environmentCache = (db: Db): EnvironmentCache => ({
  async read() {
    const [row] = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, ENVIRONMENT_ID_KEY));
    return row?.value ?? null;
  },
  async write(environmentId) {
    await db
      .insert(appConfig)
      .values({ key: ENVIRONMENT_ID_KEY, value: environmentId })
      .onConflictDoUpdate({
        set: { updatedAt: new Date(), value: environmentId },
        target: appConfig.key,
      });
  },
});

/** Null when the integration is off, which every caller must handle. */
export const createGateway = (db: Db, env: Env): AnthropicGateway | null => {
  if (!isAnthropicEnabled(env)) {
    return null;
  }
  return createAnthropicGateway(
    new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
    {
      cache: environmentCache(db),
      environmentName: ENVIRONMENT_NAME,
    }
  );
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const systemPromptFor = (agent: Agent, all: readonly Agent[]): string =>
  composeSystemPrompt({
    instructions: agent.instructions,
    name: agent.name,
    roster: rosterFor(agent.id, all),
    soul: agent.soul,
  });

/**
 * Rewrites the system prompt of every already-registered agent except `skipId`.
 * Rosters are part of the prompt, so creating, renaming or deleting one agent
 * makes every other agent's prompt stale. There are a handful of agents, so
 * "update them all" beats tracking which ones actually changed.
 */
const resyncRosters = async (
  db: Db,
  gateway: AnthropicGateway,
  skipId: string | null
): Promise<void> => {
  const all = await listAgents(db);
  for (const agent of all) {
    if (agent.id === skipId || !agent.anthropicAgentId) {
      continue;
    }
    try {
      // Sequential on purpose: agent updates are create-rate-limited (300 RPM)
      // and one failure must not take the others down with it.
      // biome-ignore lint/performance/noAwaitInLoops: paced to stay inside the API's rate limits
      await gateway.syncAgent({
        anthropicAgentId: agent.anthropicAgentId,
        name: agent.name,
        system: systemPromptFor(agent, all),
      });
      await setAgentSyncStatus(db, agent.id, "synced");
    } catch (error) {
      await setAgentSyncStatus(db, agent.id, "error", messageOf(error));
    }
  }
};

export interface SyncAgentOptions {
  /**
   * The agent's MCP endpoint. Only known when its token was just issued, since
   * the token is stored hashed - omit it to leave the registered URL as is.
   */
  mcpUrl?: string;
}

/**
 * Registers (or updates) one agent with Anthropic, then refreshes everyone
 * else's roster. Never throws: failures land in the agent's `syncStatus`, which
 * the agent rail shows.
 */
export const syncAgentWithAnthropic = async (
  db: Db,
  env: Env,
  agentId: string,
  options: SyncAgentOptions = {}
): Promise<void> => {
  const gateway = createGateway(db, env);
  if (!gateway) {
    return;
  }

  const all = await listAgents(db);
  const agent = all.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return;
  }

  try {
    const system = systemPromptFor(agent, all);
    if (agent.anthropicAgentId) {
      await gateway.syncAgent({
        anthropicAgentId: agent.anthropicAgentId,
        mcpUrl: options.mcpUrl,
        name: agent.name,
        system,
      });
      await setAgentSyncStatus(db, agent.id, "synced");
    } else if (options.mcpUrl) {
      const registration = await gateway.registerAgent({
        instructions: agent.instructions,
        mcpUrl: options.mcpUrl,
        name: agent.name,
        system,
      });
      await setAgentRegistration(db, agent.id, registration);
    } else {
      // An agent created before this phase: its plaintext MCP token is gone, so
      // there is no URL to register with. Rotating the token issues a new one.
      await setAgentSyncStatus(
        db,
        agent.id,
        "error",
        "No MCP URL available. Rotate this agent's MCP token to register it with Anthropic."
      );
      return;
    }
  } catch (error) {
    await setAgentSyncStatus(db, agent.id, "error", messageOf(error));
  }

  await resyncRosters(db, gateway, agent.id);
};

/** After a delete, the survivors' rosters still name the agent that left. */
export const resyncRostersWithAnthropic = async (
  db: Db,
  env: Env
): Promise<void> => {
  const gateway = createGateway(db, env);
  if (!gateway) {
    return;
  }
  await resyncRosters(db, gateway, null);
};
