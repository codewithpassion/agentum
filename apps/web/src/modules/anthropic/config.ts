/**
 * Every knob the Anthropic integration turns, in one place. The Managed Agents
 * API is in beta, so anything version-shaped (model id, toolset version,
 * environment name) is pinned here rather than inlined at the call sites.
 */

/** One model for every agent until per-agent model choice earns its keep. */
export const AGENT_MODEL = "claude-sonnet-5";

/** The single reusable environment. Names are unique per workspace. */
export const ENVIRONMENT_NAME = "agentum";

/** Session spend ceiling, in minor units: "100" is $1.00. */
export const SESSION_BUDGET_CENTS = "100";
export const SESSION_BUDGET_CURRENCY = "USD";

/** The toolset version our agents are built against. */
export const AGENT_TOOLSET = "agent_toolset_20260401";

/** The name our MCP server is registered under, referenced by the toolset. */
export const MCP_SERVER_NAME = "agentum";

export const MEMORY_STORE_INSTRUCTIONS =
  "Your long-term memory. Keep durable facts about the workspace, the people and agents in it, and how you like to work here. Read it before starting, and update it when you learn something worth remembering next time.";
