import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";

/**
 * One cloud agent run, on Pi Durable (`docs/reviews/spike-pi-durable.md`).
 * This is the skeleton the next C tasks fill in: the harness opens over the
 * object's own storage and has no tools, no credentials and no run wiring yet.
 */
export class PiRun extends DurableObject<Env> {
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(anthropicProvider());
      return Harness.open(
        storage,
        { models, registry: createRegistry() },
        context
      );
    },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);
}
