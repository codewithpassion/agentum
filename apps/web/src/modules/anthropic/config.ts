/**
 * Every knob the Anthropic integration turns, in one place. The Managed Agents
 * API is in beta, so anything version-shaped (model id, toolset version,
 * environment name) is pinned here rather than inlined at the call sites.
 */

/** The workspace default: what an agent runs on until somebody picks otherwise. */
export const AGENT_MODEL = "claude-sonnet-5";

/**
 * Every model an agent may be set to, in the order a picker should offer them.
 * Plain model strings only - `model_config` extras (effort, inference geo, fast
 * premium) are deliberately out of scope.
 *
 * This list is the validation boundary: every place a model enters from outside
 * (HTTP API, MCP tools) checks against it, and anything stored that is no longer
 * on it falls back to the default rather than being sent to the API.
 */
export const AVAILABLE_MODELS = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: AGENT_MODEL, label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

export type AvailableModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export const isAvailableModel = (id: unknown): id is AvailableModelId =>
  typeof id === "string" && AVAILABLE_MODELS.some((model) => model.id === id);

/** The catalog ids, for the message a rejected model gets back. */
export const AVAILABLE_MODEL_IDS: string = AVAILABLE_MODELS.map(
  (model) => model.id
).join(", ");

/**
 * The cheap, quick model behind the decisions that sit *in front of* an agent
 * rather than being its work: is this thread message meant for you, and what
 * should the "thinking" line say while you answer. Both run on the path a human
 * is waiting on, and neither is worth a frontier model.
 *
 * Haiku 4.5 predates `output_config.effort` and adaptive thinking - it takes
 * neither - so the calls in `fast.ts` pass only a model, a cap and messages.
 */
export const FAST_MODEL = "claude-haiku-4-5";

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
