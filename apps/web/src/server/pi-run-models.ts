import {
  type CredentialStore,
  createModels,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/** Every OpenRouter quantization except fp4. */
const OPENROUTER_QUANTIZATIONS = [
  "int4",
  "int8",
  "fp6",
  "fp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
];

/**
 * Adds OpenRouter routing to each request. Routing keeps the providers that
 * serve these quantizations and accept every parameter in the request. It
 * sets no `order` or `only`, which would turn off sticky routing and the
 * prompt cache. A caller's `onPayload` runs first and its result is the base.
 */
function routedOnPayload<TModel>(
  onPayload: ((payload: unknown, model: TModel) => unknown) | undefined
) {
  return async (payload: unknown, model: TModel): Promise<unknown> => {
    const base = (await onPayload?.(payload, model)) ?? payload;
    if (typeof base !== "object" || base === null) {
      return base;
    }
    const existing =
      "provider" in base &&
      typeof base.provider === "object" &&
      base.provider !== null
        ? base.provider
        : {};
    return {
      ...base,
      provider: {
        ...existing,
        quantizations: OPENROUTER_QUANTIZATIONS,
        require_parameters: true,
      },
    };
  };
}

function withOpenRouterRouting(provider: Provider): Provider {
  return {
    ...provider,
    stream: (model, context, options) =>
      provider.stream(
        model,
        context,
        // biome-ignore lint/style/useObjectSpread: an object spread does not type-check against the generic ApiStreamOptions<T>
        Object.assign({}, options, {
          onPayload: routedOnPayload(options?.onPayload),
        })
      ),
    streamSimple: (model, context, options) =>
      provider.streamSimple(
        model,
        context,
        // biome-ignore lint/style/useObjectSpread: an object spread does not type-check against SimpleStreamOptions
        Object.assign({}, options, {
          onPayload: routedOnPayload(options?.onPayload),
        })
      ),
  };
}

/**
 * The auth context reports no env vars and no files, so an `ANTHROPIC_API_KEY`
 * or `OPENROUTER_API_KEY` in the Worker's environment never reaches a cloud
 * run. The workspace keys are the only auth sources.
 */
export function createCloudModels(credentials: CredentialStore): MutableModels {
  const models = createModels({
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
    credentials,
  });
  models.setProvider(anthropicProvider());
  models.setProvider(withOpenRouterRouting(openrouterProvider()));
  return models;
}
