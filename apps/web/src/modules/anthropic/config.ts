/**
 * Every knob the Anthropic integration turns, in one place. The Managed Agents
 * API is in beta, so anything version-shaped (model id, toolset version,
 * environment name) is pinned here rather than inlined at the call sites.
 */

/** The workspace default: what an agent runs on until somebody picks otherwise. */
export const AGENT_MODEL = "claude-sonnet-5-5";

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
  {
    description: "Most capable, for the hardest work",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
  },
  {
    description: "Balanced speed and capability",
    id: AGENT_MODEL,
    label: "Sonnet 5.5",
  },
  {
    description: "Fastest and cheapest",
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
  },
] as const;

export type AvailableModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export const isAvailableModel = (id: unknown): id is AvailableModelId =>
  typeof id === "string" && AVAILABLE_MODELS.some((model) => model.id === id);

/** A stored model the catalog no longer offers runs on the default instead. */
export const modelOrDefault = (id: string | null | undefined): string =>
  isAvailableModel(id) ? id : AGENT_MODEL;

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
 * The calls in `fast.ts` pass only a model, a cap and messages, so they need
 * no `output_config.effort` or thinking support from the model.
 */
export const FAST_MODEL = "claude-haiku-5-5";

/**
 * The same job on Workers AI, for a deployment or workspace with no Anthropic
 * key: a small instruct model, picked for latency over judgement, since the
 * questions are one-liners with a fallback either way.
 */
export const FAST_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** The single reusable environment. Names are unique per workspace. */
export const ENVIRONMENT_NAME = "agentum";

/**
 * The shared subagent worker: one per API key, rostered on every agent so long
 * mechanical work runs on a cheap model in a background thread instead of
 * inside the agent's own turn. It has the sandbox toolset and nothing else -
 * no MCP servers - so it cannot post to the workspace; the coordinator relays.
 */
export const WORKER_AGENT_NAME = "Worker";
export const WORKER_AGENT_MODEL = "claude-haiku-5-5";
export const WORKER_AGENT_DESCRIPTION =
  "Fast, low-cost subagent for mechanical, well-specified work: downloads, conversions, bulk file processing, running scripts, scraping. Give it one self-contained task with the exact inputs, file paths and the report format you want back.";
export const WORKER_AGENT_SYSTEM =
  "You are a worker subagent. Do exactly the task you are given, nothing more. Work with the tools you have, verify your results (file sizes, exit codes, spot checks) and report back concisely: what you did, the exact paths of any outputs, and anything that failed. You cannot post to the workspace - your report to the agent that spawned you is your only output.";

/** Session spend ceiling, in minor units: "1000" is $10.00. */
export const SESSION_BUDGET_CENTS = "1000";
export const SESSION_BUDGET_CURRENCY = "USD";

/** The toolset version our agents are built against. */
export const AGENT_TOOLSET = "agent_toolset_20260401";

/** The name our MCP server is registered under, referenced by the toolset. */
export const MCP_SERVER_NAME = "agentum";

/**
 * The client-run custom tool that shows the model its computer's desktop.
 * The name may not start with `mcp__`/`ant__` or clash with a built-in.
 */
export const DESKTOP_SCREENSHOT_TOOL = "desktop_screenshot";
export const DESKTOP_SCREENSHOT_DESCRIPTION =
  "Capture your computer's desktop (1280x800) and look at it. The screenshot comes back in the result.";

export const MEMORY_STORE_INSTRUCTIONS =
  "Your long-term memory. Keep durable facts about the workspace, the people and agents in it, and how you like to work here. Read it before starting, and update it when you learn something worth remembering next time.";
