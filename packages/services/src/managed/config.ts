/**
 * Every knob the Managed Agents integration turns, in one place. The Managed
 * Agents API is in beta, so anything version-shaped (model id, toolset version,
 * environment name) is pinned here rather than inlined at the call sites.
 */

/** The workspace default: what an agent runs on until somebody picks otherwise. */
export const AGENT_MODEL = "claude-sonnet-5-5";

/**
 * Every model an agent may be set to, in the order a picker should offer them.
 * Plain model strings only - `model_config` extras (effort, inference geo, fast
 * premium) are deliberately out of scope.
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

/** Short names that stand for a catalog id. */
const MODEL_ALIASES = new Map<string, AvailableModelId>([
  ["haiku", "claude-haiku-5-5"],
  ["opus", "claude-opus-5-5"],
  ["sonnet", AGENT_MODEL],
]);

/**
 * Resolves a model alias or id to one the catalog offers. Anything else, an
 * unknown id included, runs on the workspace default rather than being sent to
 * the API as is.
 */
export const modelFor = (model: string): string => {
  const value = model.trim().toLowerCase();
  const alias = MODEL_ALIASES.get(value);
  if (alias) {
    return alias;
  }
  return isAvailableModel(value) ? value : AGENT_MODEL;
};

/** The single reusable environment. Names are unique per workspace. */
export const ENVIRONMENT_NAME = "harbourmaster";

/** Session spend ceiling, in minor units: "1000" is $10.00. */
export const SESSION_BUDGET_CENTS = "1000";
export const SESSION_BUDGET_CURRENCY = "USD";

/** The toolset version our agents are built against. */
export const AGENT_TOOLSET = "agent_toolset_20260401";
