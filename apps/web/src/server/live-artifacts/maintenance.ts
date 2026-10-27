import { DurableObject } from "cloudflare:workers";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { compose } from "../compose";
import { requiredLive } from "./required";

/** A durable repeated sweep, independent of request waitUntil and minute cron.
 * Re-arm before work so repeated failures cannot exhaust platform retries. */
export class LiveArtifactMaintenance extends DurableObject<Env> {
  async start() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }
  override async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + 2000);
    const live = requiredLive(compose(this.env, false).services);
    for (const sweep of [live.retryInvalidations, live.retryDispatches]) {
      let cursor: string | undefined;
      do {
        // biome-ignore lint/performance/noAwaitInLoops: durable pagination must finish a page before using its cursor.
        const page = await sweep(SYSTEM_PRINCIPAL, { cursor, limit: 100 });
        cursor = page.next;
      } while (cursor);
    }
  }
}
