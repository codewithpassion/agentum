import { expect, test } from "bun:test";
import { durableRunnerPort } from "./pi-run-port.ts";

test("answered wakes the object of the run's session", async () => {
  const woken: string[] = [];
  const namespace = {
    get: (id: string) => ({
      requestAnswered: (runId: string, requestId: string) => {
        woken.push(`${id} ${runId} ${requestId}`);
        return Promise.resolve();
      },
    }),
    idFromName: (name: string) => `object-of-${name}`,
  };

  await durableRunnerPort(
    namespace as unknown as Parameters<typeof durableRunnerPort>[0]
  ).answered?.("run1", "session1", "req1");

  expect(woken).toEqual(["object-of-session1 run1 req1"]);
});
