import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { mcpUrlForToken } from "#/modules/agents/mcp-token";
import type { Agent } from "#/modules/agents/schema";
import {
  clearConnectorResyncPending,
  getAgentByIdUnscoped,
  listAgents,
  listAgentsPendingConnectorResync,
  rotateMcpToken,
  setAgentRegistration,
  setAgentSyncStatus,
} from "#/modules/agents/service";
import { listConnectorsForAgent } from "#/modules/connectors/service";
import { MAX_AGENT_CONNECTORS } from "#/modules/connectors/usability";
import { listAgentSkillAssignments } from "#/modules/skills/service";
import { composeAgentConnectors } from "./agent-connectors";
import { composeAgentSkills } from "./agent-skills";
import { AGENT_MODEL, ENVIRONMENT_NAME } from "./config";
import {
  type AnthropicGateway,
  createAnthropicGateway,
  type IdCache,
} from "./gateway";
import {
  appConfig,
  ENVIRONMENT_ID_KEY,
  environmentIdKeyFor,
  WORKER_AGENT_ID_KEY,
  workerAgentIdKeyFor,
} from "./schema";
import { composeSystemPrompt, rosterFor } from "./system-prompt";
import {
  MissingConnectorKeyError,
  type ResolvedAnthropicKey,
  resolveAnthropicKey,
} from "./workspace-keys";

/**
 * The Worker-facing half of the Anthropic integration: it owns the client, the
 * environment-id cache, and keeping every agent's registration in step with the
 * workspace. Registration is best-effort by design - the UI must work with no
 * key configured and with the API down.
 */

const DISABLED = "1";
const E2E_MODE = "e2e";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The two guards that override everything, a workspace's own key included: the
 * deployment kill switch, and the end-to-end suite, which drives a dev server
 * that loads the same `.env.local` and must never create real agents or
 * sessions.
 *
 * Whether a key exists at all is deliberately no longer asked here. A workspace
 * with its own key has to work on a deployment that has no global one, and only
 * the resolver knows that - so this stays sync, and the call sites that are
 * merely asking "is the integration switched on" stay sync with it.
 *
 * The mode check is what makes the e2e guard possible. A Worker variable cannot
 * do it: `.env.local` outranks both the process environment and `CLOUDFLARE_ENV`
 * (verified 2026-08-20), so there is no way to unset the key for one run. Vite's
 * mode does reach the Worker bundle, and `playwright.config.ts` starts the
 * server with `--mode e2e`.
 */
export const isAnthropicEnabled = (env: Env): boolean =>
  env.ANTHROPIC_DISABLED !== DISABLED && import.meta.env.MODE !== E2E_MODE;

/**
 * The key a workspace's Anthropic calls run on, or null when there is none and
 * nothing should be attempted. The one place the three factories - gateway,
 * vaults, skills - agree on what "enabled for this workspace" means.
 *
 * Never throws. The single failure the resolver raises - a workspace key stored
 * against a `CONNECTOR_KEY` that has since gone missing - is a deployment fault
 * rather than an agent's, but the agent rail is the only screen this
 * integration's failures reach, so that is where it is recorded. Every caller
 * then reads the null exactly as it already reads "no key configured".
 */
export const anthropicKeyFor = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<ResolvedAnthropicKey | null> => {
  if (!isAnthropicEnabled(env)) {
    return null;
  }
  try {
    return await resolveAnthropicKey(db, env, workspaceId);
  } catch (error) {
    if (!(error instanceof MissingConnectorKeyError)) {
      throw error;
    }
    const message = messageOf(error);
    await Promise.all(
      (await listAgents(db, workspaceId)).map((agent) =>
        setAgentSyncStatus(db, agent.id, "error", message)
      )
    );
    return null;
  }
};

const idCache = (db: Db, key: string): IdCache => ({
  async read() {
    const [row] = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, key));
    return row?.value ?? null;
  },
  async write(environmentId) {
    await db
      .insert(appConfig)
      .values({ key, value: environmentId })
      .onConflictDoUpdate({
        set: { updatedAt: new Date(), value: environmentId },
        target: appConfig.key,
      });
  },
});

/**
 * Null when the integration is off for this workspace, which every caller must
 * handle.
 *
 * A workspace on its own key gets its own environment cache entry - an
 * environment belongs to the key that created it - while a workspace on the
 * global key keeps the deployment-wide entry. That is what makes deleting a
 * workspace key fall back cleanly rather than onto a stale per-workspace id.
 */
export const createGateway = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<AnthropicGateway | null> => {
  const resolved = await anthropicKeyFor(db, env, workspaceId);
  if (!resolved) {
    return null;
  }
  const scoped = resolved.source === "workspace";
  return createAnthropicGateway(new Anthropic({ apiKey: resolved.apiKey }), {
    cache: idCache(
      db,
      scoped ? environmentIdKeyFor(workspaceId) : ENVIRONMENT_ID_KEY
    ),
    environmentName: ENVIRONMENT_NAME,
    workerCache: idCache(
      db,
      scoped ? workerAgentIdKeyFor(workspaceId) : WORKER_AGENT_ID_KEY
    ),
  });
};

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
  workspaceId: string,
  skipId: string | null
): Promise<void> => {
  const all = await listAgents(db, workspaceId);
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
        model: agent.model ?? AGENT_MODEL,
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

const cappedMessage = (dropped: number): string =>
  `${dropped} connector${dropped === 1 ? "" : "s"} could not be attached: an agent may declare ${MAX_AGENT_CONNECTORS} connectors plus the workspace server. Unassign the extras.`;

/**
 * The single place an agent's configuration is pushed, with the gateway handed
 * in so the whole path is testable. `mcpUrl` decides which of two updates this
 * is:
 *
 * - **with** it - creation, a manual token rotation, a connector resync - the
 *   entire `mcp_servers` array is replaced, so the agent's connectors are
 *   loaded and sent alongside it. Leaving them out would wipe them.
 * - **without** it - a rename, a roster refresh, and skills in phase 5 - only
 *   the name and system prompt move, and the registered MCP URL (whose
 *   plaintext token cannot be reconstructed) is preserved untouched.
 *
 * Returns whether the push landed; failures are recorded on the agent row
 * rather than thrown, because registration is best-effort everywhere.
 */
export const syncAgentToAnthropic = async (
  db: Db,
  gateway: AnthropicGateway,
  agentId: string,
  options: SyncAgentOptions = {}
): Promise<boolean> => {
  // The roster in the system prompt is the workspace's own, and no wider: an
  // agent must never be told about a teammate it cannot reach.
  const found = await getAgentByIdUnscoped(db, agentId);
  if (!found) {
    return false;
  }
  const all = await listAgents(db, found.workspaceId);
  const agent = all.find((candidate) => candidate.id === agentId) ?? found;

  const composed = options.mcpUrl
    ? composeAgentConnectors(await listConnectorsForAgent(db, agentId))
    : null;

  try {
    const system = systemPromptFor(agent, all);
    if (agent.anthropicAgentId) {
      await gateway.syncAgent({
        anthropicAgentId: agent.anthropicAgentId,
        connectors: composed?.servers,
        mcpUrl: options.mcpUrl,
        model: agent.model ?? AGENT_MODEL,
        name: agent.name,
        system,
      });
    } else if (options.mcpUrl) {
      const registration = await gateway.registerAgent({
        connectors: composed?.servers,
        instructions: agent.instructions,
        mcpUrl: options.mcpUrl,
        model: agent.model ?? AGENT_MODEL,
        name: agent.name,
        // A first registration is normally an agent with no assignments at all;
        // it carries skills only for one that was assigned some while an
        // earlier registration attempt was failing.
        skills: composeAgentSkills(await listAgentSkillAssignments(db, agentId))
          .skills,
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
      return false;
    }
  } catch (error) {
    await setAgentSyncStatus(db, agent.id, "error", messageOf(error));
    return false;
  }

  if (options.mcpUrl) {
    // Any successful full push pays off whatever a connector change owed: the
    // array that just landed is the current one, however the rotation arose.
    await clearConnectorResyncPending(db, agent.id);
  }

  if (composed && composed.dropped.length > 0) {
    await setAgentSyncStatus(
      db,
      agent.id,
      "error",
      cappedMessage(composed.dropped.length)
    );
    return true;
  }
  await setAgentSyncStatus(db, agent.id, "synced");
  return true;
};

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
  const agent = await getAgentByIdUnscoped(db, agentId);
  if (!agent) {
    return;
  }
  // The agent first: which key this pushes on is the workspace's business now.
  const gateway = await createGateway(db, env, agent.workspaceId);
  if (!gateway) {
    return;
  }

  await syncAgentToAnthropic(db, gateway, agentId, options);
  await resyncRosters(db, gateway, agent.workspaceId, agentId);
};

// --- skills -----------------------------------------------------------------

const droppedSkillsMessage = (
  dropped: readonly { reason: string; slug: string }[]
): string =>
  `${dropped.length} skill${dropped.length === 1 ? "" : "s"} could not be attached: ${dropped
    .map((entry) => `"${entry.slug}" (${entry.reason})`)
    .join(", ")}.`;

/**
 * Pushes an agent's skills, and only its skills.
 *
 * Unlike a connector change this needs no token rotation and no session-idle
 * wait: the update carries `skills` alone, so the agent's registered MCP URL -
 * whose plaintext token exists only at issuance - is untouched. That is what
 * makes it safe to run the moment an assignment changes, including from an
 * agent's own `skill_create` mid-session.
 */
export const syncAgentSkillsToAnthropic = async (
  db: Db,
  gateway: AnthropicGateway,
  agentId: string
): Promise<boolean> => {
  const agent = await getAgentByIdUnscoped(db, agentId);
  if (!agent?.anthropicAgentId) {
    // Nothing registered yet: the assignment reaches Anthropic when the agent
    // is first registered, which sends the composed skills with it.
    return false;
  }

  const composed = composeAgentSkills(
    await listAgentSkillAssignments(db, agentId)
  );
  try {
    await gateway.syncAgentSkills({
      anthropicAgentId: agent.anthropicAgentId,
      skills: composed.skills,
    });
  } catch (error) {
    await setAgentSyncStatus(db, agent.id, "error", messageOf(error));
    return false;
  }

  if (composed.dropped.length > 0) {
    await setAgentSyncStatus(
      db,
      agent.id,
      "error",
      droppedSkillsMessage(composed.dropped)
    );
    return true;
  }
  await setAgentSyncStatus(db, agent.id, "synced");
  return true;
};

/**
 * The transport-facing wrapper: a no-op when the integration is off. The
 * workspace is named rather than derived from the agents, because it is what
 * decides the key - and every caller is inside one already.
 */
export const syncAgentSkillsWithAnthropic = async (
  db: Db,
  env: Env,
  workspaceId: string,
  agentIds: readonly string[]
): Promise<void> => {
  const gateway = await createGateway(db, env, workspaceId);
  if (!gateway) {
    return;
  }
  for (const agentId of agentIds) {
    // Sequential for the same reason as the roster pass: agent updates are
    // rate-limited, and one failure must not take the others down.
    // biome-ignore lint/performance/noAwaitInLoops: paced to stay inside the API's rate limits
    await syncAgentSkillsToAnthropic(db, gateway, agentId).catch(() => {
      // Recorded on the agent row; nothing here is worth failing a request for.
    });
  }
};

// --- connector resync -------------------------------------------------------

export interface ConnectorResyncDeps {
  /**
   * Where our MCP endpoint lives. Null when neither `PUBLIC_APP_URL` nor a
   * request says, in which case no URL can be minted and the debt waits.
   */
  appBaseUrl: string | null;
  db: Db;
  gateway: AnthropicGateway;
}

export type ConnectorResyncOutcome =
  | "deferred"
  | "failed"
  | "skipped"
  | "synced";

/** The base is already resolved here; the request URL is only its fallback. */
const mcpUrlFor = (appBaseUrl: string, token: string): string =>
  mcpUrlForToken(appBaseUrl, appBaseUrl, token);

/**
 * Pushes an agent's connectors after an assignment (or a connector) changed.
 *
 * An update replaces the whole `mcp_servers` array, and the workspace entry
 * carries a token that only exists at issuance - so the only way to rewrite the
 * array is to rotate the token and send the URL it yields. That invalidates the
 * agent's current MCP endpoint, which is why it waits until the agent has no
 * session: `sessionId` is the gate, and the caller's `connectorResyncPendingAt`
 * flag is what makes the debt survive the wait (and a failed attempt).
 */
export const resyncAgentConnectors = async (
  deps: ConnectorResyncDeps,
  agentId: string
): Promise<ConnectorResyncOutcome> => {
  const agent = await getAgentByIdUnscoped(deps.db, agentId);
  if (!agent) {
    return "skipped";
  }
  if (agent.sessionId) {
    // Rotating now would cut a running session off from the workspace MCP.
    return "deferred";
  }
  if (!deps.appBaseUrl) {
    return "skipped";
  }

  const rotated = await rotateMcpToken(deps.db, agent.workspaceId, agentId);
  if (!rotated) {
    return "skipped";
  }

  // The old URL is dead from here, whatever the API says next. On failure the
  // flag stays set and the retry - at the latest just before the agent's next
  // session - rotates again.
  // A successful push clears the flag itself - it is the debt being paid.
  const pushed = await syncAgentToAnthropic(deps.db, deps.gateway, agentId, {
    mcpUrl: mcpUrlFor(deps.appBaseUrl, rotated.mcpToken),
  });
  return pushed ? "synced" : "failed";
};

const appBaseUrlFor = (env: Env, requestUrl?: string): string | null => {
  if (env.PUBLIC_APP_URL) {
    return env.PUBLIC_APP_URL;
  }
  if (!requestUrl) {
    return null;
  }
  try {
    return new URL(requestUrl).origin;
  } catch {
    return null;
  }
};

/**
 * Everything a connector change left stale, resynced as far as it can be right
 * now. Agents with a live session stay marked and are picked up by the router
 * when theirs ends.
 */
export const resyncPendingAgents = async (
  db: Db,
  env: Env,
  requestUrl?: string
): Promise<void> => {
  const appBaseUrl = appBaseUrlFor(env, requestUrl);
  const pending = await listAgentsPendingConnectorResync(db);
  // The debt is deployment-wide but the key is not, so there is one gateway per
  // workspace rather than one for the sweep. Resolved up front, nulls included:
  // a workspace whose key will not resolve must be asked once, not once per
  // agent it owns.
  const gateways = new Map(
    await Promise.all(
      [...new Set(pending.map((agent) => agent.workspaceId))].map(
        async (workspaceId) =>
          [workspaceId, await createGateway(db, env, workspaceId)] as const
      )
    )
  );

  for (const agent of pending) {
    const gateway = gateways.get(agent.workspaceId);
    if (!gateway) {
      continue;
    }
    // Sequential for the same reason as the roster pass: agent updates are
    // rate-limited, and one failure must not take the others down.
    // biome-ignore lint/performance/noAwaitInLoops: paced to stay inside the API's rate limits
    await resyncAgentConnectors({ appBaseUrl, db, gateway }, agent.id).catch(
      () => {
        // Recorded on the agent row; the flag keeps the debt for the next try.
      }
    );
  }
};

/**
 * Re-registers a workspace's agents after its own API key was set, rotated or
 * removed.
 *
 * Every Anthropic id the workspace held was forgotten by the reset, and a fresh
 * registration needs an MCP URL - whose plaintext token exists only at issuance
 * - so the way back is the connector-resync path: rotate the token, push the
 * whole configuration, and let `registerAgent` mint a new agent under the new
 * key. The reset also records that push as owed, which is what makes this a
 * retry rather than the only attempt: a failure here leaves the debt for the
 * next connector change (`resyncPendingAgents`) or for an edit that rotates the
 * agent's MCP token. A plain edit will not do - with no id and no URL it can
 * only tell the human to rotate - which is why this runs at the key change.
 *
 * Skills are deliberately not swept. Their mirrors come back through the
 * existing per-skill retry, and rebuilding every version's upload from R2 is
 * far too much work to hang off a settings save. An agent registered before
 * that retry runs simply carries no skills yet - they are pushed when it does.
 */
export const resyncWorkspaceAfterKeyChange = async (
  db: Db,
  env: Env,
  workspaceId: string,
  requestUrl?: string
): Promise<void> => {
  const owing = (await listAgents(db, workspaceId)).filter(
    (agent) => agent.connectorResyncPendingAt
  );
  // Before the gateway, so a workspace with nothing to re-register costs
  // nothing at all - not even resolving the key it just set.
  if (owing.length === 0) {
    return;
  }

  const gateway = await createGateway(db, env, workspaceId);
  if (!gateway) {
    return;
  }
  const deps: ConnectorResyncDeps = {
    appBaseUrl: appBaseUrlFor(env, requestUrl),
    db,
    gateway,
  };
  for (const agent of owing) {
    // biome-ignore lint/performance/noAwaitInLoops: paced to stay inside the API's rate limits
    await resyncAgentConnectors(deps, agent.id).catch(() => {
      // Recorded on the agent row; the flag keeps the debt for the next try.
    });
  }
};

/** The router's hook: one agent, at the moment it stops having a session. */
export const resyncAgentConnectorsWithAnthropic = async (
  db: Db,
  env: Env,
  agentId: string
): Promise<void> => {
  const agent = await getAgentByIdUnscoped(db, agentId);
  if (!agent) {
    return;
  }
  const gateway = await createGateway(db, env, agent.workspaceId);
  if (!gateway) {
    return;
  }
  await resyncAgentConnectors(
    { appBaseUrl: appBaseUrlFor(env), db, gateway },
    agentId
  );
};

/**
 * The vaults the agent's next session may use. Create-only on Anthropic's side,
 * so this is read once, when the session is made.
 */
export const sessionVaultIdsFor = async (
  db: Db,
  agentId: string
): Promise<string[]> =>
  composeAgentConnectors(await listConnectorsForAgent(db, agentId)).vaultIds;

/**
 * After a delete, the survivors' rosters still name the agent that left. Only
 * the deleted agent's own workspace is touched - no other roster ever named it.
 */
export const resyncRostersWithAnthropic = async (
  db: Db,
  env: Env,
  workspaceId: string
): Promise<void> => {
  const gateway = await createGateway(db, env, workspaceId);
  if (!gateway) {
    return;
  }
  await resyncRosters(db, gateway, workspaceId, null);
};
