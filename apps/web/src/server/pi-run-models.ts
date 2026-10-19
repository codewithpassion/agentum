import {
  type Api,
  type CredentialStore,
  createModels,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  type CostProbe,
  createCostProbe,
  withReportedCost,
} from "./openrouter-cost.ts";

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

const DEEPSEEK_FLASH_BASE = "deepseek/deepseek-v4.1-flash";
const DEEPSEEK_FLASH_1017 = "deepseek/deepseek-v4.1-flash-1017";

/**
 * pi-ai 1.3.0 predates `deepseek/deepseek-v4.1-flash-1017` (created 17 Oct
 * 2026), so a Pi run on it would end with `no_model`. This entry is the
 * bundled V4.1 Flash with the values from the OpenRouter models API on
 * 19 Oct 2026: 1,048,576 context, 393,216 max completion tokens, text and
 * image input, and the standard rate in USD per million tokens (OpenRouter
 * halves it off-peak). Pi's cost is only an estimate, used only when a
 * response has no `usage.cost`.
 */
const extraOpenRouterModels = (
  base: readonly Model<Api>[]
): readonly Model<Api>[] => {
  const flash = base.find((model) => model.id === DEEPSEEK_FLASH_BASE);
  if (!flash || base.some((model) => model.id === DEEPSEEK_FLASH_1017)) {
    return [];
  }
  return [
    {
      ...flash,
      contextWindow: 1_048_576,
      cost: { cacheRead: 0.006, cacheWrite: 0, input: 0.3, output: 1.2 },
      id: DEEPSEEK_FLASH_1017,
      maxTokens: 393_216,
      name: "DeepSeek: DeepSeek V4.1 Flash 1017",
    },
  ];
};

/**
 * Feeds every parsed stream chunk to the cost probe. A caller's
 * `onProviderStreamEvent` runs first.
 */
function observedCost<TModel>(
  onProviderStreamEvent:
    | ((data: unknown, model: TModel) => void | Promise<void>)
    | undefined,
  probe: CostProbe
) {
  return async (data: unknown, model: TModel): Promise<void> => {
    await onProviderStreamEvent?.(data, model);
    probe.observe(data);
  };
}

function withOpenRouterRouting(provider: Provider): Provider {
  return {
    ...provider,
    getAllModels: () => {
      const models = provider.getAllModels?.() ?? provider.getModels();
      return [...models, ...extraOpenRouterModels(provider.getModels())];
    },
    getModels: () => {
      const models = provider.getModels();
      return [...models, ...extraOpenRouterModels(models)];
    },
    stream: (model, context, options) => {
      const probe = createCostProbe();
      return withReportedCost(
        provider.stream(
          model,
          context,
          // biome-ignore lint/style/useObjectSpread: an object spread does not type-check against the generic ApiStreamOptions<T>
          Object.assign({}, options, {
            onPayload: routedOnPayload(options?.onPayload),
            onProviderStreamEvent: observedCost(
              options?.onProviderStreamEvent,
              probe
            ),
          })
        ),
        probe
      );
    },
    streamSimple: (model, context, options) => {
      const probe = createCostProbe();
      return withReportedCost(
        provider.streamSimple(
          model,
          context,
          // biome-ignore lint/style/useObjectSpread: an object spread does not type-check against SimpleStreamOptions
          Object.assign({}, options, {
            onPayload: routedOnPayload(options?.onPayload),
            onProviderStreamEvent: observedCost(
              options?.onProviderStreamEvent,
              probe
            ),
          })
        ),
        probe
      );
    },
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
