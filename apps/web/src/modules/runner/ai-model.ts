import { type ChatModel, parseCompletion, toWireRequest } from "./chat";
import { isWorkersAiModel } from "./models";

/**
 * The `AI` binding as a `ChatModel`. One binding reaches both Workers AI
 * (`@cf/...`) and, through AI Gateway, third-party providers
 * (`openai/...`, `anthropic/...`); the gateway is what carries the provider
 * credentials, whether unified billing or a key stored on it.
 *
 * Routing is deliberate rather than automatic: a Workers AI model goes through
 * a gateway only when the deployment names one (`AI_GATEWAY_ID`), because an
 * auto-created gateway would quietly change where usage is logged and billed.
 * A third-party model has no way around one, so it falls back to `default`,
 * which Cloudflare creates on first use.
 */

const DEFAULT_GATEWAY_ID = "default";

export interface AiModelOptions {
  /** `AI_GATEWAY_ID`, when the deployment set one. */
  gatewayId?: string;
}

export const gatewayFor = (
  model: string,
  gatewayId: string | undefined
): { gateway: { id: string } } | undefined => {
  if (gatewayId) {
    return { gateway: { id: gatewayId } };
  }
  return isWorkersAiModel(model)
    ? undefined
    : { gateway: { id: DEFAULT_GATEWAY_ID } };
};

/** The binding's loosest overload: any model name, plain objects both ways. */
type AnyModelRun = (
  model: string,
  inputs: Record<string, unknown>,
  options?: { gateway?: { id: string } }
) => Promise<unknown>;

export const createAiChatModel = (
  ai: Ai,
  options: AiModelOptions = {}
): ChatModel => ({
  async complete(request) {
    const run = ai.run.bind(ai) as AnyModelRun;
    const raw = await run(
      request.model,
      { ...toWireRequest(request) },
      gatewayFor(request.model, options.gatewayId)
    );
    return parseCompletion(raw);
  },
});
