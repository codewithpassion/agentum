import { DurableObject } from "cloudflare:workers";
import { compose } from "./compose.ts";
import { createPollerCore, type PollerCore } from "./managed-poller-core.ts";

/**
 * One managed run's poller (`idFromName(runId)`). An alarm wakes the run's
 * poll step until the run finishes, so a managed run keeps moving while nobody
 * has its page open.
 *
 * The logic is in `managed-poller-core.ts`. This class is the part only a real
 * Worker can run: the alarm and the storage it lives in.
 */
export class ManagedPoller extends DurableObject<Env> {
  #core: PollerCore | undefined;

  #poller(): PollerCore {
    this.#core ??= createPollerCore({
      interrupt: (runId) =>
        compose(
          this.env,
          import.meta.env.DEV,
          (w) => this.ctx.waitUntil(w),
          this.ctx.exports
        ).services.managed.interrupt(runId),
      now: Date.now,
      step: (runId) =>
        compose(
          this.env,
          import.meta.env.DEV,
          (w) => this.ctx.waitUntil(w),
          this.ctx.exports
        ).services.managed.step(runId),
      storage: this.ctx.storage,
    });
    return this.#core;
  }

  override alarm(): Promise<void> {
    return this.#poller().alarm();
  }

  // The calls below are RPC from the Worker, through `managed-poller-port.ts`.

  kick(runId: string): Promise<void> {
    return this.#poller().kick(runId);
  }

  cancelRun(runId: string): Promise<void> {
    return this.#poller().cancel(runId);
  }
}
