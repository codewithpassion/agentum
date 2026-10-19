/**
 * Models a cloud agent can run on. Cloud agents run Pi on a Durable Object.
 * Anthropic models call the Anthropic API directly. Other providers are
 * named with a prefix, such as `openrouter:z-ai/glm-5.3`. This module imports
 * nothing at runtime, so the web app can import it for the form.
 */
import type { ModelProvider } from "@repo/db/shared";

export type CloudProvider = "anthropic" | ModelProvider;

export type CloudModelInput = "image" | "text";

export interface CloudModel {
  alias?: string;
  description: string;
  id: string;
  input: readonly CloudModelInput[];
  label: string;
  provider: CloudProvider;
}

export const CLOUD_DEFAULT_MODEL = "claude-sonnet-5-5";

export const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

/** In the order a picker should offer them. */
export const CLOUD_MODELS: readonly CloudModel[] = [
  {
    alias: "opus",
    description: "Most capable, for the hardest work",
    id: "claude-opus-5-5",
    input: ["text", "image"],
    label: "Opus 5.5",
    provider: "anthropic",
  },
  {
    alias: "sonnet",
    description: "Balanced speed and capability",
    id: CLOUD_DEFAULT_MODEL,
    input: ["text", "image"],
    label: "Sonnet 5.5",
    provider: "anthropic",
  },
  {
    alias: "haiku",
    description: "Fastest and cheapest",
    id: "claude-haiku-5-5",
    input: ["text", "image"],
    label: "Haiku 5.5",
    provider: "anthropic",
  },
  {
    description: "Open model through OpenRouter, text only",
    id: "z-ai/glm-5.3",
    input: ["text"],
    label: "GLM-5.3",
    provider: "openrouter",
  },
  {
    description: "Open model through OpenRouter, text and images",
    id: "z-ai/glm-5.3-flash",
    input: ["text", "image"],
    label: "GLM-5.3 Flash",
    provider: "openrouter",
  },
  {
    description: "Open model through OpenRouter, text and images",
    id: "deepseek/deepseek-v4.1-flash",
    input: ["text", "image"],
    label: "DeepSeek V4.1 Flash",
    provider: "openrouter",
  },
];

const PREFIXED_PROVIDERS = Object.keys(CLOUD_PROVIDER_LABELS).filter(
  (provider): provider is ModelProvider => provider !== "anthropic"
);

/**
 * Splits a model string into its provider and id. A `<provider>:` prefix
 * names a non-Anthropic provider. Anything else, including a Bedrock id with
 * a colon, is an Anthropic model.
 */
export const parseModelRef = (
  model: string
): { id: string; provider: CloudProvider } => {
  const value = model.trim();
  const colon = value.indexOf(":");
  if (colon > 0) {
    const prefix = value.slice(0, colon).toLowerCase();
    const provider = PREFIXED_PROVIDERS.find((name) => name === prefix);
    if (provider) {
      return { id: value.slice(colon + 1).trim(), provider };
    }
  }
  return { id: value, provider: "anthropic" };
};

/** True when the model runs on the Anthropic API. */
export const isAnthropicModel = (model: string): boolean =>
  parseModelRef(model).provider === "anthropic";

/** The string a run uses for a catalog entry: the bare id for Anthropic, else `provider:id`. */
export const cloudModelRef = (entry: CloudModel): string =>
  entry.provider === "anthropic" ? entry.id : `${entry.provider}:${entry.id}`;

/** The value a picker stores: the alias when there is one, else the model ref. */
export const cloudModelValue = (entry: CloudModel): string =>
  entry.alias ?? cloudModelRef(entry);

/** Finds the catalog entry for an alias or a model ref, ignoring case and spaces. */
export const findCloudModel = (model: string): CloudModel | undefined => {
  const value = model.trim().toLowerCase();
  return CLOUD_MODELS.find(
    (entry) => entry.alias === value || cloudModelRef(entry) === value
  );
};

/**
 * Resolves an alias or a catalog model ref to the ref a run uses, such as
 * `claude-sonnet-5-5` or `openrouter:z-ai/glm-5.3`. Anything else comes back
 * trimmed but otherwise unchanged, so an unknown id fails at the API instead
 * of running on another model.
 */
export const cloudModelFor = (model: string): string => {
  const match = findCloudModel(model);
  return match ? cloudModelRef(match) : model.trim();
};

/** Returns a message naming the valid models when `model` is not one of them. */
export const cloudModelError = (model: string): string | undefined => {
  if (findCloudModel(model)) {
    return;
  }
  const valid = CLOUD_MODELS.map((entry) =>
    entry.alias ? `${entry.alias} (${entry.id})` : cloudModelRef(entry)
  ).join(", ");
  return `Unknown model "${model.trim()}". Valid cloud models: ${valid}.`;
};
