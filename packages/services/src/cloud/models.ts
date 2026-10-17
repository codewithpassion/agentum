/**
 * Models a cloud agent can run on. Cloud agents run Pi on a Durable Object
 * against the Anthropic API. This module imports nothing, so the web app can
 * import it for the form.
 */

export const CLOUD_DEFAULT_MODEL = "claude-sonnet-5-5";

/** In the order a picker should offer them. */
export const CLOUD_MODELS = [
  {
    alias: "opus",
    description: "Most capable, for the hardest work",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
  },
  {
    alias: "sonnet",
    description: "Balanced speed and capability",
    id: CLOUD_DEFAULT_MODEL,
    label: "Sonnet 5.5",
  },
  {
    alias: "haiku",
    description: "Fastest and cheapest",
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
  },
] as const;

/** Finds the catalog entry for an alias or a catalog id, ignoring case and spaces. */
export const findCloudModel = (model: string) => {
  const value = model.trim().toLowerCase();
  return CLOUD_MODELS.find(
    (entry) => entry.alias === value || entry.id === value
  );
};

/**
 * Resolves an alias or a catalog id to its catalog id. Anything else comes
 * back trimmed but otherwise unchanged, so an unknown id fails at the API
 * instead of running on another model.
 */
export const cloudModelFor = (model: string): string => {
  const match = findCloudModel(model);
  return match ? match.id : model.trim();
};

/** Returns a message naming the valid models when `model` is not one of them. */
export const cloudModelError = (model: string): string | undefined => {
  if (findCloudModel(model)) {
    return;
  }
  const valid = CLOUD_MODELS.map(
    (entry) => `${entry.alias} (${entry.id})`
  ).join(", ");
  return `Unknown model "${model.trim()}". Valid cloud models: ${valid}.`;
};
