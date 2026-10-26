import { expect, test } from "bun:test";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import type { Services } from "../compose.ts";
import { automationJobs, GITHUB_UPDATE_BATCH } from "./automation.ts";
import { tickJobs } from "./jobs.ts";
import type { TickDeps } from "./registry.ts";

const JOB = "skills-github-updates";

const jobAt = (minute: number) => {
  const calls: unknown[][] = [];
  const deps = {
    clock: {
      now: () => new Date(Date.UTC(2026, 9, 27, 9, minute)),
      sleep: () => Promise.resolve(),
    },
    services: {
      skillsStore: {
        checkUpdates: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve({ available: 0, failures: [] });
        },
      },
    } as unknown as Services,
  } satisfies TickDeps;
  const job = automationJobs.find(({ name }) => name === JOB);
  if (!job) {
    throw new Error(`${JOB} is not registered`);
  }
  return { calls, run: () => job.run(deps) };
};

test("the GitHub update job is registered with the minute tick", () => {
  expect(tickJobs.map(({ name }) => name)).toContain(JOB);
});

test("on a fifth minute it checks a small batch as the system", async () => {
  for (const minute of [0, 5, 30, 55]) {
    const { calls, run } = jobAt(minute);
    // biome-ignore lint/performance/noAwaitInLoops: Each minute has its own spy.
    await run();
    expect(calls).toEqual([[SYSTEM_PRINCIPAL, { limit: GITHUB_UPDATE_BATCH }]]);
  }
});

test("on the other minutes it makes no GitHub call", async () => {
  for (const minute of [1, 4, 29, 59]) {
    const { calls, run } = jobAt(minute);
    // biome-ignore lint/performance/noAwaitInLoops: Each minute has its own spy.
    await run();
    expect(calls).toEqual([]);
  }
});
