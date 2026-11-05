import { expect, test } from "bun:test";
import { taskStatus } from "./task-behaviour.ts";
import { publishTaskControl, taskControlSnapshot } from "./task-control.ts";

test("the live control snapshot drives the cyan pill and replaces the pending rail request", () => {
  publishTaskControl({ agentName: "Echo", requestId: "req", runId: "run" });
  expect(taskControlSnapshot()).toEqual({
    agentName: "Echo",
    requestId: "req",
    runId: "run",
  });
  expect(taskStatus("waiting", true, taskControlSnapshot() !== null).text).toBe(
    "You have control"
  );
  publishTaskControl(null);
  expect(taskControlSnapshot()).toBe(null);
  expect(taskStatus("waiting", true, false).text).toBe("Needs you");
});
