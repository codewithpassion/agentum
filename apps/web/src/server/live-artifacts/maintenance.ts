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
    const live = requiredLive(
      compose(this.env, false, undefined, this.ctx.exports).services
    );
    const sweeps = [
      live.retryInvalidations,
      live.retryDispatches,
      live.retryMentions,
    ];
    const lastTick = await this.ctx.storage.get<number>("checkpointTick");
    if (lastTick === undefined || lastTick + 60_000 <= Date.now()) {
      sweeps.push(live.retryCheckpoints);
      await this.ctx.storage.put("checkpointTick", Date.now());
    }
    const results = await Promise.allSettled(
      sweeps.map(async (sweep) => {
        let cursor: string | undefined;
        do {
          // biome-ignore lint/performance/noAwaitInLoops: durable pagination must finish a page before using its cursor.
          const page = await sweep(SYSTEM_PRINCIPAL, { cursor, limit: 100 });
          cursor = page.next;
        } while (cursor);
      })
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  }
}
