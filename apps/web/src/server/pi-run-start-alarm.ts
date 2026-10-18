import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { START_RETRY_MS } from "./pi-run-start.ts";

const CAPABILITY_ID = "harbourmaster-run-start";
const JOB_ID = "run-start";
const START_FN = "start";

/**
 * The alarm that starts accepted runs. A Durable Object alarm survives an
 * eviction and fires again after a crash, so a start the object saved is
 * finished even if the Worker's request is long gone. The Lifecycle job queue
 * owns the one physical alarm, shared with the lease beat and the harness.
 */
export class RunStartAlarm extends LifecycleCapability {
  readonly #work: () => Promise<boolean>;

  /** `work` resolves to whether a start must be tried again later. */
  constructor(work: () => Promise<boolean>) {
    super(CAPABILITY_ID);
    this.#work = work;
  }

  /** Makes sure the saved starts are worked now. */
  async schedule(): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: START_FN,
      id: JOB_ID,
      singleflight: true,
      time: Date.now(),
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== START_FN) {
      return;
    }
    try {
      return (await this.#work())
        ? { rescheduleAt: Date.now() + START_RETRY_MS }
        : undefined;
    } catch (error) {
      console.error(
        "PiRun: working saved starts failed",
        error instanceof Error ? error.message : String(error)
      );
      return { rescheduleAt: Date.now() + START_RETRY_MS };
    }
  }
}
