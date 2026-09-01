/**
 * Models the Cloudflare runtime can run on. All of them are addressed through
 * the `AI` binding: a `@cf/` id runs on Workers AI, and a `{provider}/{model}`
 * id is a third-party model reached through AI Gateway (billed by unified
 * billing or a key stored on the gateway - see `ai-model.ts`).
 *
 * The catalog is a set of suggestions, not the validation boundary the
 * Anthropic one is: any id of the right shape is accepted, because the model
 * list on both sides moves faster than this file will.
 */

export const CLOUDFLARE_DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.5";

export const CLOUDFLARE_MODELS = [
  { id: CLOUDFLARE_DEFAULT_MODEL, label: "Kimi K2.5 (Workers AI)" },
  { id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash (Workers AI)" },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM 4.7 Flash (Workers AI)" },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B (Workers AI)" },
  {
    id: "anthropic/claude-sonnet-4-5",
    label: "Claude Sonnet 4.5 (via AI Gateway - needs credits or a stored key)",
  },
  {
    id: "openai/gpt-5.2",
    label: "GPT-5.2 (via AI Gateway - needs credits or a stored key)",
  },
] as const;

/** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` or `anthropic/claude-sonnet-4-5`. */
const MODEL_ID = /^(?:@cf\/)?[\w.-]+\/[\w.@:-]+(?:\/[\w.@:-]+)*$/;

const MODEL_ID_MAX_LENGTH = 200;

export const isCloudflareModelShaped = (id: unknown): id is string =>
  typeof id === "string" &&
  id.length <= MODEL_ID_MAX_LENGTH &&
  MODEL_ID.test(id);

/** Hosted on Workers AI, as opposed to reached through AI Gateway. */
export const isWorkersAiModel = (id: string): boolean =>
  id.startsWith("@cf/") || id.startsWith("@hf/");
