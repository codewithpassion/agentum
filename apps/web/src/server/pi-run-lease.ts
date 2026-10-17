import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { HEARTBEAT_MS } from "./pi-run-core.ts";

const CAPABILITY_ID = "harbourmaster-run-lease";
const JOB_ID = "run-lease";
const BEAT_FN = "beat";

/**
 * The alarm that keeps cloud runs alive. A Durable Object alarm survives an
 * eviction and fires again after a crash, so the lease keeps moving while the
 * object is awake and the object is woken to move it. The Lifecycle job queue
 * owns the one physical alarm, and PiHarness shares it with its own wake job.
 *
 * Each beat extends the lease of every active run and works the ones nothing
 * is working. It repeats while any run is active.
 */
export class RunLeaseAlarm extends LifecycleCapability {
  readonly #beat: () => Promise<boolean>;

  constructor(beat: () => Promise<boolean>) {
    super(CAPABILITY_ID);
    this.#beat = beat;
  }

  /**
   * Makes sure a beat is due within one interval. A beat that is running at
   * this moment is replaced, so a run that starts as the last one ends is not
   * left without an alarm.
   */
  async schedule(): Promise<void> {
    const due = Date.now() + HEARTBEAT_MS;
    const pending = this.lifecycle.jobs.get(JOB_ID);
    await this.lifecycle.jobs.push({
      fn: BEAT_FN,
      id: JOB_ID,
      singleflight: true,
      time: pending ? Math.min(pending.time, due) : due,
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== BEAT_FN) {
      return;
    }
    try {
      return (await this.#beat())
        ? { rescheduleAt: Date.now() + HEARTBEAT_MS }
        : undefined;
    } catch (error) {
      // A failed beat must not end the alarm: the lease is what keeps the run alive.
      console.error(
        "PiRun: lease beat failed",
        error instanceof Error ? error.message : String(error)
      );
      return { rescheduleAt: Date.now() + HEARTBEAT_MS };
    }
  }
}
