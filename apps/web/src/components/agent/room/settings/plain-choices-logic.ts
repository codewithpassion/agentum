import {
  CONTEXT_BUDGETS,
  type ContextBudget,
  EFFORT_LEVELS,
  type EffortLevel,
} from "@repo/db/shared";
import type { RuntimeConfig } from "@repo/services/agents";
import { findCloudModel } from "@repo/services/cloud/models";

export interface PlainChoice<T extends string> {
  description: string;
  label: string;
  value: T;
}

export type Capability = "opus" | "sonnet" | "haiku";

/** The option value that means "no setting". */
export const NOT_SET = "";

const CAPABILITIES: readonly Capability[] = ["opus", "sonnet", "haiku"];

export const CAPABILITY_CHOICES: readonly PlainChoice<Capability>[] = [
  {
    description: "For the hardest work. Slowest and costs the most.",
    label: "Most capable",
    value: "opus",
  },
  {
    description: "Good speed and quality for most work.",
    label: "Balanced",
    value: "sonnet",
  },
  {
    description: "For simple, repeated work.",
    label: "Fast and cheap",
    value: "haiku",
  },
];

export const THINKING_CHOICES: readonly PlainChoice<EffortLevel>[] = [
  {
    description: "Answers fast with little deliberation.",
    label: "Quick",
    value: "low",
  },
  {
    description: "Thinks a fair amount before it answers.",
    label: "Balanced",
    value: "medium",
  },
  {
    description: "Thinks longer before it answers. Costs more.",
    label: "Thorough",
    value: "high",
  },
];

export const CONTEXT_CHOICES: readonly PlainChoice<ContextBudget>[] = [
  {
    description: "Loads less of the conversation. Faster and cheaper.",
    label: "Small",
    value: "small",
  },
  {
    description: "The usual amount.",
    label: "Standard",
    value: "standard",
  },
  {
    description: "Loads more of the conversation and files. Costs more.",
    label: "Large",
    value: "large",
  },
];

const isCapability = (value: unknown): value is Capability =>
  CAPABILITIES.some((capability) => capability === value);

const isEffortLevel = (value: unknown): value is EffortLevel =>
  EFFORT_LEVELS.some((level) => level === value);

const isContextBudget = (value: unknown): value is ContextBudget =>
  CONTEXT_BUDGETS.some((budget) => budget === value);

/** The tier of an agent's model, or null for a model that is none of the three. */
export const capabilityOf = (model: string): Capability | null => {
  const alias = findCloudModel(model)?.alias;
  return isCapability(alias) ? alias : null;
};

/** The saved thinking level, or NOT_SET when none or when the stored value is not one of EFFORT_LEVELS. */
export const thinkingOf = (
  runtimeConfig: Readonly<Record<string, unknown>>
): EffortLevel | typeof NOT_SET => {
  const value = runtimeConfig.effort;
  return isEffortLevel(value) ? value : NOT_SET;
};

/** The saved context size, or NOT_SET when none or when the stored value is not one of CONTEXT_BUDGETS. */
export const contextOf = (
  runtimeConfig: Readonly<Record<string, unknown>>
): ContextBudget | typeof NOT_SET => {
  const value = runtimeConfig.contextBudget;
  return isContextBudget(value) ? value : NOT_SET;
};

const withoutKey = (config: RuntimeConfig, key: string): RuntimeConfig =>
  Object.fromEntries(Object.entries(config).filter(([name]) => name !== key));

/** A copy of the config with `effort` set to value; NOT_SET removes the key; a value that is not an effort level (and not NOT_SET) returns an unchanged copy. */
export const withEffort = (
  config: RuntimeConfig,
  value: string
): RuntimeConfig => {
  if (value === NOT_SET) {
    return withoutKey(config, "effort");
  }
  if (!isEffortLevel(value)) {
    return { ...config };
  }
  return { ...config, effort: value };
};

/** A copy of the config with `contextBudget` set to value; NOT_SET removes the key; a value that is not a context budget (and not NOT_SET) returns an unchanged copy. */
export const withContextBudget = (
  config: RuntimeConfig,
  value: string
): RuntimeConfig => {
  if (value === NOT_SET) {
    return withoutKey(config, "contextBudget");
  }
  if (!isContextBudget(value)) {
    return { ...config };
  }
  return { ...config, contextBudget: value };
};
