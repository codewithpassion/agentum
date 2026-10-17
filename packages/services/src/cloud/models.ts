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

/**
 * Resolves an alias or a catalog id to its catalog id. Anything else comes
 * back trimmed but otherwise unchanged, so an unknown id fails at the API
 * instead of running on another model.
 */
export const cloudModelFor = (model: string): string => {
  const value = model.trim().toLowerCase();
  const match = CLOUD_MODELS.find(
    (entry) => entry.alias === value || entry.id === value
  );
  return match ? match.id : model.trim();
};
