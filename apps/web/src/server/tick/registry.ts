// The minute tick. `scheduled()` in server.ts composes the services and calls
// `runTick` with every registered job. Each lane registers its jobs from its
// own file (tick/runtime.ts, tick/access.ts, tick/automation.ts) and
// tick/jobs.ts lists them, so lanes never edit the same file.
import type { Clock } from "@repo/services/runs/types";
import type { Services } from "../compose.ts";

export interface TickDeps {
  clock: Clock;
  services: Services;
}

export interface TickJob {
  /** Unique across lanes; it names the job in the tick's report and logs. */
  name: string;
  /**
   * Does one slice of work. Jobs run in parallel and must be safe to run
   * again: an overlapping tick or a retry can repeat a slice.
   */
  run: (deps: TickDeps) => Promise<unknown>;
}

export interface TickReport {
  /** When the tick started, by the injected clock. */
  at: string;
  jobs: { error?: string; name: string; ok: boolean }[];
}

/**
 * Runs every job once. A job that throws is reported and does not stop the
 * others, because the next minute retries it.
 */
export const runTick = async (
  jobs: readonly TickJob[],
  deps: TickDeps
): Promise<TickReport> => {
  const names = new Set<string>();
  for (const { name } of jobs) {
    if (names.has(name)) {
      throw new Error(`Two tick jobs are named ${name}`);
    }
    names.add(name);
  }
  const at = deps.clock.now().toISOString();
  const reports = await Promise.all(
    jobs.map(async ({ name, run }) => {
      try {
        await run(deps);
        return { name, ok: true };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          name,
          ok: false,
        };
      }
    })
  );
  return { at, jobs: reports };
};
