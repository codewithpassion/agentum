import { AGENT_MODEL, AVAILABLE_MODELS } from "#/modules/anthropic/config";
import {
  CLOUDFLARE_DEFAULT_MODEL,
  CLOUDFLARE_MODELS,
} from "#/modules/runner/models";

/**
 * Model ids as a person should read them. The catalog in
 * `modules/anthropic/config` is the source of truth for both the ids and their
 * labels, so this is only the lookup - nothing here names a model itself.
 */

/**
 * An id the catalog no longer offers is shown as itself rather than hidden: a
 * row pinned to a retired model is still pinned to it, and that is exactly the
 * fact worth putting on screen.
 */
export const modelLabel = (id: string): string =>
  AVAILABLE_MODELS.find((model) => model.id === id)?.label ??
  CLOUDFLARE_MODELS.find((model) => model.id === id)?.label ??
  id;

/** What an agent with no model of its own runs on, named. */
export const WORKSPACE_DEFAULT_MODEL_LABEL = `Workspace default (${modelLabel(AGENT_MODEL)})`;

/** The same, for an agent on the Cloudflare runtime. */
export const CLOUDFLARE_DEFAULT_MODEL_LABEL = `Runtime default (${modelLabel(CLOUDFLARE_DEFAULT_MODEL)})`;

/** A routine with no model of its own runs on whatever its agent runs on. */
export const AGENT_DEFAULT_MODEL_LABEL = "Agent default";
